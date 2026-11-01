import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import * as script from '../../../../script.js';

const MODULE = 'forum_plugin';
const POS_KEY = 'forum_plugin_pos';
const SIZE_KEY = 'forum_plugin_size';
const PLATFORMS = ['forum', 'tieba', 'weibo', 'xhs'];
const PLATFORM_NAMES = { forum: '论坛', tieba: '贴吧', weibo: '微博', xhs: '小红书' };
const STAGE_NAMES = ['初现', '回应', '爆料', '退潮'];
const EDGE = 8;
const MIN_W = 320;
const MIN_H = 340;
const CHAR_PROMPT_CAP = 9000;   // 角色私聊提示词的字符预算
const CHAR_HIST_MAX = 16;       // 最多回看多少条私聊历史

const defaultConfig = {
  customPrompt: '', readChat: false, readPersona: false, readWorld: false,
  genCount: 2, distance: 0, alias: '',
  postCount: 3, replyCount: 2, stirCount: 3,
  charUseST: false,
};

let currentFilter = 'all';
let currentTag = null;
let currentEvent = null;
let stirOpenId = null;
let stirDraft = '';
let busy = false;            // 帖子相关的生成
let busyLabel = '';
let imBusy = false;          // 消息面板里的生成（角色私聊 / 陌生网友 / 漂流瓶）
let retakeLock = false;      // 重新生成的同步锁，补 imBusy 置位前的空档
let lastError = null;
let activeDM = null;
let activeChar = null;
let pendingFwd = null;
let msgTab = 'char';
let uidSeq = 0;
let sessionAlias = '';
const detachedStore = { threads: [], hidden: [], events: [], dms: [], chats: {} };

/* ============================== 工具 ============================== */

function makeId(p = 't') {
  uidSeq += 1;
  return `${p}_${Date.now().toString(36)}_${uidSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function notify(type, msg) {
  try {
    if (window.toastr && typeof window.toastr[type] === 'function') { window.toastr[type](msg, '幻境社区'); return; }
  } catch (e) { /* 忽略 */ }
  if (type === 'error' || type === 'warning') { try { alert('幻境社区：' + msg); return; } catch (e) { /* 忽略 */ } }
  console.log('[幻境社区]', msg);
}

function initial(name) {
  const s = str(name) || '匿';
  return escapeHtml(s.charAt(0).toUpperCase());
}

function timeAgo(ts) {
  const diff = Date.now() - Number(ts);
  if (!ts || !Number.isFinite(diff) || diff < 60000) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(Number(ts)).toLocaleDateString();
}

function clampPct(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

function autoAlias() {
  return '匿名用户' + String(Math.floor(Math.random() * 90) + 10);
}

function myAlias() {
  const set = str(getConfig().alias);
  if (set) return set;
  if (!sessionAlias) sessionAlias = autoAlias();
  return sessionAlias;
}

// 任何一路在跑就不让另一路开始。
// generateQuietPrompt 并发会互相串结果，必须全局互锁。
function anyBusy() {
  return busy || imBusy || retakeLock;
}

// 当前聊天的身份标记。生成前后对比，防止把内容写进已经切走的聊天
function chatToken() {
  try {
    const ctx = getContext();
    if (typeof ctx.getCurrentChatId === 'function') return 'c:' + String(ctx.getCurrentChatId() ?? '');
    return 'f:' + String(ctx.chatId ?? '') + '/' + String(ctx.groupId ?? '') + '/' + String(ctx.characterId ?? '');
  } catch (e) {
    return '';
  }
}

/* ============================== 配置 ============================== */

function getConfig() {
  try {
    const ctx = getContext();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings[MODULE]) {
      let config = { ...defaultConfig };
      const saved = localStorage.getItem('forum_plugin_config');
      if (saved) { try { config = { ...config, ...JSON.parse(saved) }; } catch (e) { /* 忽略 */ } }
      ctx.extensionSettings[MODULE] = config;
      persistSettings(ctx);
    }
    return { ...defaultConfig, ...ctx.extensionSettings[MODULE] };
  } catch (e) {
    return { ...defaultConfig };
  }
}

function saveConfig(config) {
  try {
    const ctx = getContext();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    ctx.extensionSettings[MODULE] = config;
    persistSettings(ctx);
  } catch (e) {
    try { localStorage.setItem('forum_plugin_config', JSON.stringify(config)); } catch (err) { /* 忽略 */ }
  }
}

function persistSettings(ctx) {
  if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
  else if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
}

function distanceOf(config) {
  return clampInt(config.distance, 0, 2, 0);
}

function scaleOf(config) {
  return {
    threads: clampInt(config.genCount, 1, 5, 2),
    posts: clampInt(config.postCount, 1, 12, 3),
    replies: clampInt(config.replyCount, 0, 6, 2),
    stir: clampInt(config.stirCount, 1, 8, 3),
  };
}

function tokenBudget(threadCount, sc) {
  const per = 260 + sc.posts * 75 + sc.posts * sc.replies * 32;
  return Math.min(12000, Math.max(1200, 500 + threadCount * per));
}

/* ============================== 数据 ============================== */

function getData() {
  let ctx = null;
  try { ctx = getContext(); } catch (e) { /* 忽略 */ }
  const meta = ctx && (ctx.chatMetadata || ctx.chat_metadata);
  if (!meta || typeof meta !== 'object') return detachedStore;

  if (!meta[MODULE] || typeof meta[MODULE] !== 'object') meta[MODULE] = {};
  const d = meta[MODULE];
  if (!Array.isArray(d.threads)) d.threads = [];
  if (!Array.isArray(d.hidden)) d.hidden = [];
  if (!Array.isArray(d.events)) d.events = [];
  if (!Array.isArray(d.dms)) d.dms = [];
  if (!d.chats || typeof d.chats !== 'object') d.chats = {};
  return d;
}

function saveAll() {
  try {
    const ctx = getContext();
    if (typeof ctx?.saveMetadataDebounced === 'function') return ctx.saveMetadataDebounced();
    if (typeof script.saveMetadataDebounced === 'function') return script.saveMetadataDebounced();
    if (typeof ctx?.saveMetadata === 'function') return ctx.saveMetadata();
  } catch (e) {
    console.warn('[幻境社区] 保存元数据失败', e);
  }
}

function normalize(data) {
  let changed = false;

  if (data.threads.some(t => !t || String(t.id ?? '').startsWith('error_') || (!str(t.content) && !str(t.title)))) {
    data.threads = data.threads.filter(t => t && !String(t.id ?? '').startsWith('error_') && (str(t.content) || str(t.title)));
    changed = true;
  }
  data.threads.forEach(t => {
    if (!t.id) { t.id = makeId(); changed = true; }
    if (!Array.isArray(t.posts)) { t.posts = []; changed = true; }
  });

  const live = new Set(data.threads.map(t => String(t.id)));
  const pruned = data.hidden.map(String).filter(id => live.has(id));
  if (pruned.length !== data.hidden.length) { data.hidden = pruned; changed = true; }

  if (changed) saveAll();
  return data;
}

function findThread(id) {
  const key = String(id);
  return getData().threads.find(t => String(t.id) === key);
}

function findEvent(id) {
  const key = String(id);
  return getData().events.find(e => String(e.id) === key);
}

function eventThreads(eventId) {
  const key = String(eventId);
  return getData().threads.filter(t => String(t.eventId || '') === key);
}

function newestOfEvent(eventId) {
  const list = eventThreads(eventId);
  if (!list.length) return null;
  return list.reduce((a, b) => ((b.stage ?? 0) >= (a.stage ?? 0) ? b : a));
}

function unreadDM() {
  return getData().dms.filter(d => d.unread).length;
}

/* ============================== 角色 ============================== */

function getChars() {
  try {
    const ctx = getContext();
    const all = Array.isArray(ctx.characters) ? ctx.characters : [];
    const out = [];

    if (ctx.groupId && Array.isArray(ctx.groups)) {
      const g = ctx.groups.find(x => String(x.id) === String(ctx.groupId));
      const off = new Set(g?.disabled_members || []);
      (g?.members || []).forEach(av => {
        if (off.has(av)) return;
        const c = all.find(ch => ch.avatar === av);
        if (c) out.push(c);
      });
      return out;
    }

    const id = ctx.characterId;
    if (id !== undefined && id !== null && all[id]) out.push(all[id]);
    return out;
  } catch (e) {
    return [];
  }
}

function charKey(c) {
  return str(c?.avatar) || str(c?.name) || 'char';
}

function charName(c) {
  return str(c?.name) || str(c?.data?.name) || '角色';
}

function charAvatarUrl(c) {
  const av = str(c?.avatar);
  if (!av || av === 'none') return '';
  try {
    const ctx = getContext();
    if (typeof ctx.getThumbnailUrl === 'function') return ctx.getThumbnailUrl('avatar', av);
  } catch (e) { /* 忽略 */ }
  return `/thumbnail?type=avatar&file=${encodeURIComponent(av)}`;
}

function findCharByKey(key) {
  if (!key) return null;
  return getChars().find(c => charKey(c) === String(key)) || null;
}

function getChat(key) {
  const data = getData();
  if (!data.chats[key]) data.chats[key] = { messages: [] };
  if (!Array.isArray(data.chats[key].messages)) data.chats[key].messages = [];
  return data.chats[key];
}

function macro(s) {
  const text = str(s);
  if (!text) return '';
  try {
    const ctx = getContext();
    if (typeof ctx.substituteParams === 'function') return str(ctx.substituteParams(text));
  } catch (e) { /* 忽略 */ }
  return text;
}

function userName() {
  try {
    return str(getContext().name1) || '我';
  } catch (e) {
    return '我';
  }
}

/* ============================== 提示词 ============================== */

const IRON_RULES = `【铁律 · 永远是局外人】
1. 发帖人和所有回复人必须是你凭空捏造的网名（吃瓜路人甲、赛博小青蛙、Momo、键盘侠007、匿名用户 等）。
2. 绝对禁止扮演故事里的任何角色：不准写他们的台词、心理活动、动作描写。
3. 网友只能在"外面"议论、猜测、带节奏，他们没有现场的完整视角。`;

const RUMOR_RULES = `【传闻失真规则 · 必须执行】
a. 至少一条回复用非常肯定的语气说出一个错误的结论。
b. 至少一条回复提到一个真实但被误读的细节。
c. 信源必须不可靠："我表哥在那边上班""内部人士说""有图但很糊""听我同事讲"。
d. 任何人都不许把真相说完整。知道真相的读者要能看出他们错在哪。`;

function distanceBlock(level) {
  if (level >= 2) {
    return `${IRON_RULES}

【距离 · 直击】
4. 故事里发生的事、涉及的人，就是本批帖子的核心话题。
5. 可以使用故事里已经公开流传的称呼、代号、名字；私密信息只能用模糊代称（"那个人""穿黑衣的那位"）。
6. 网友必须分成几派互相吵，其中至少一派的判断明显是错的。

${RUMOR_RULES}`;
  }
  if (level === 1) {
    return `${IRON_RULES}

【距离 · 擦边】
4. 话题必须围绕故事世界里的事件、地名、组织、势力、传闻展开。
5. 严禁出现任何具体人名/角色名。提到人只能用"有人""一伙人""某些人""那位"。
6. 所有信息都是二手的、残缺的、道听途说的。

${RUMOR_RULES}`;
  }
  return `${IRON_RULES}

【距离 · 无关】
4. 帖子内容是与故事完全无关的网民日常：吐槽、八卦、求助、分享。
5. 严禁出现任何故事里的人名、地名、事件。`;
}

const PLATFORM_BLOCK = `【平台特征】
- weibo（微博）：短平快。营销号味，标题党、情绪大于事实，可带 #话题#。标题可为空。
- tieba（贴吧）：前几楼还算认真，后面开始跑题、玩梗、互相嘴。标题常带【水贴】【求助】。
- forum（论坛）：长文深度讨论，列点梳理时间线，语气专业。标题常带【讨论】【分析】。
- xhs（小红书）：包装成避雷/指南/攻略，emoji 排版，标题带感叹号，结尾可软性引流。`;

function postCountRule(sc) {
  const lo = Math.max(1, sc.posts - 1);
  const hi = sc.posts + 1;
  const nest = sc.replies > 0
    ? `其中至少 ${Math.min(2, sc.posts)} 条回复要带楼中楼，每条楼中楼不超过 ${sc.replies} 层。`
    : `不要生成楼中楼，所有 "replies" 一律填空数组 []。`;
  return `每条帖子必须有 ${lo} 到 ${hi} 条网友回复（目标 ${sc.posts} 条）。${nest}`;
}

function recentChat(ctx, n) {
  if (!Array.isArray(ctx.chat) || !ctx.chat.length) return '';
  return ctx.chat.slice(-n)
    .filter(m => m && !m.is_system)
    .map(m => `${m.name}: ${String(m.mes || '').replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');
}

async function worldBlock(ctx) {
  try {
    if (typeof script.getWorldInfoPrompt === 'function') {
      const wi = await script.getWorldInfoPrompt(ctx.chat, 3000, true);
      if (wi?.worldInfoString) return str(wi.worldInfoString);
    }
  } catch (e) { /* 忽略 */ }
  return '';
}

async function storyBlock(ctx, config) {
  const level = distanceOf(config);
  let s = '';

  if (config.customPrompt) s += `\n【世界观设定】\n${config.customPrompt}\n`;

  if (level >= 1 || config.readChat) {
    const chat = recentChat(ctx, level >= 2 ? 12 : 6);
    if (chat) {
      s += level >= 1
        ? `\n【故事近况 · 真相】（网友只听说了其中极小一部分，而且会传错。严禁照抄人名当网名）\n${chat}\n`
        : `\n【聊天氛围（仅供参考，禁止照抄名字）】\n${chat}\n`;
    }
  }

  if (config.readPersona) {
    const persona = ctx.powerUserSettings?.personas?.[ctx.name1] || ctx.powerUserSettings?.persona_description || '';
    if (persona) s += `\n【当事人设定（仅作背景，网友不掌握这些）】\n${persona}\n`;
  }

  if (config.readWorld) {
    const wi = await worldBlock(ctx);
    if (wi) s += `\n【世界书背景】\n${wi}\n`;
  }
  return s;
}

function recentTitles() {
  const list = getData().threads.slice(-12).map(t => str(t.title) || str(t.content).slice(0, 20)).filter(Boolean);
  return list.length ? `\n【最近已经出现过的话题（不要重复）】\n${list.map(x => '· ' + x).join('\n')}\n` : '';
}

function knownHandles() {
  const names = new Set();
  getData().threads.slice(-10).forEach(t => {
    if (str(t.author)) names.add(str(t.author));
    (t.posts || []).forEach(p => { if (str(p.author) && !p.isUser) names.add(str(p.author)); });
  });
  const list = [...names].slice(0, 14);
  return list.length
    ? `\n【社区常驻 ID（可以让其中 1-2 个再次出现，保持他们的说话风格；其余请新造网名）】\n${list.join('、')}\n`
    : '';
}

const THREAD_SCHEMA = `{
  "type": "forum | tieba | weibo | xhs",
  "title": "标题，微博可为空字符串",
  "author": "凭空捏造的网名",
  "content": "正文",
  "tags": ["标签1", "标签2"],
  "vote": null 或 { "question": "问题", "options": [{ "text": "选项", "percentage": 60 }] },
  "posts": [ { "author": "网名", "content": "回复", "replies": [{ "author": "网名", "content": "楼中楼" }] } ],
  "mole": null 或 { "postIndex": 1, "identity": "这个人其实是谁", "slip": "他漏了哪个只有在场者才知道的细节" }
}`;

const MOLE_RULE = `【装路人（可选，大约三成帖子才有）】
如果设置了 "mole"：posts 里那一条回复表面上是普通网友，但实际上是当时真在现场的人、或是当事方的小号。
他的 content 里要自然地漏出一个只有在场者才知道的细节，语气依旧像个路人，绝不能自我暴露。
"postIndex" 从 0 开始，指向 posts 数组里的那一条。没有就填 null。`;

/* ============================== API ============================== */

async function callAPI(prompt, maxTokens = 800, temp = 0.95, forceST = false) {
  const config = getConfig();

  if (!forceST && config.url && config.key && config.model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(config.url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], temperature: temp }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ' · ' + body.slice(0, 200) : ''}`);
      }
      const data = await res.json();
      const raw = str(data?.choices?.[0]?.message?.content);
      if (!raw) throw new Error('接口返回了空内容');
      return raw;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('API 请求超时（120 秒）');
      throw new Error('API 失败：' + e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  let raw = '';
  if (typeof script.generateQuietPrompt === 'function') raw = await script.generateQuietPrompt(prompt, false, true, maxTokens);
  else if (typeof script.generateRaw === 'function') raw = await script.generateRaw(prompt, maxTokens, false, false);
  else throw new Error('找不到生成函数，请在设置里填写独立 API');

  raw = str(raw);
  if (!raw) throw new Error('模型返回了空内容');
  return raw;
}

function extractJson(text, want = 'array') {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const pairs = want === 'array' ? [['[', ']'], ['{', '}']] : [['{', '}'], ['[', ']']];

  for (const [open, close] of pairs) {
    const s = cleaned.indexOf(open);
    const e = cleaned.lastIndexOf(close);
    if (s !== -1 && e > s) {
      try { return JSON.parse(cleaned.slice(s, e + 1)); } catch (err) { /* 换下一种 */ }
    }
  }
  throw new Error('模型没有输出合法 JSON，可能被截断了。原文开头：' + cleaned.slice(0, 160));
}

/* ============================== 清洗 ============================== */

function sanitizePosts(arr, limit, replyLimit) {
  if (!Array.isArray(arr)) return [];
  const cap = Number.isFinite(limit) ? limit : 8;
  const rcap = Number.isFinite(replyLimit) ? replyLimit : 5;
  return arr.slice(0, cap).map(p => ({
    author: str(p?.author) || '匿名网友',
    content: str(p?.content),
    suspicious: !!p?.suspicious,
    replies: (rcap > 0 && Array.isArray(p?.replies))
      ? p.replies.slice(0, rcap).map(r => ({ author: str(r?.author) || '匿名网友', content: str(r?.content) })).filter(r => r.content)
      : [],
  })).filter(p => p.content);
}

function sanitizeThread(raw, extra = {}, sc = null) {
  const s = sc || scaleOf(getConfig());
  const t = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    id: makeId(),
    type: PLATFORMS.includes(t.type) ? t.type : (extra.type || 'forum'),
    title: str(t.title).slice(0, 140),
    author: str(t.author) || '匿名网友',
    content: str(t.content),
    tags: Array.isArray(t.tags) ? t.tags.map(str).filter(Boolean).slice(0, 5) : [],
    posts: sanitizePosts(t.posts, s.posts + 2, s.replies),
    vote: null,
    mole: null,
    isFavorited: false,
    isLiked: false,
    likes: Math.floor(Math.random() * 500) + 10,
    createdAt: Date.now(),
    ...extra,
  };

  if (!out.content && !out.title) return null;

  if (t.vote && Array.isArray(t.vote.options) && t.vote.options.length) {
    const options = t.vote.options.slice(0, 6)
      .map(o => ({ text: str(o?.text), percentage: clampPct(o?.percentage) }))
      .filter(o => o.text);
    if (options.length) out.vote = { question: str(t.vote.question) || '投票', options };
  }

  const m = t.mole;
  if (m && typeof m === 'object') {
    const idx = parseInt(m.postIndex, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < out.posts.length && (str(m.identity) || str(m.slip))) {
      out.mole = { postIndex: idx, identity: str(m.identity) || '当时就在现场的人', slip: str(m.slip), revealed: false };
    }
  }

  if (t.year) out.necro = { year: str(t.year), lastLogin: str(t.lastLogin), deadEnd: str(t.deadEnd) };
  if (t.blocked) out.blocked = true;

  return out;
}

// 把模型漏出来的小说腔清掉。
// 返回 { lines, filtered }：filtered 为 true 表示过滤后空了，已回退到原文
function cleanIM(raw, name) {
  let s = String(raw || '');
  const original = str(s);

  s = s.replace(/```[\s\S]*?```/g, '');
  // 成对星号包裹的短动作：*叹气*、**皱眉**。两侧成对且内容不含空格，避免吃掉强调语气
  s = s.replace(/(^|[\s，。！？、：;])[*＊]{1,2}([^*＊\n\s][^*＊\n]{0,40})[*＊]{1,2}(?=[\s，。！？、：;]|$)/g, '$1');
  s = s.replace(/^\s*[（(][^）)\n]{0,120}[）)]\s*$/gm, '');      // 整行旁白
  s = s.replace(/^\s*[【\[][^】\]\n]{0,40}[】\]]\s*/gm, '');      // 行首 [旁白]
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`^\\s*${esc}\\s*[:：]\\s*`, 'gm'), '');
  }
  s = s.replace(/^\s*(?:消息|回复|他说|她说)\s*[:：]\s*/gm, '');

  const lines = s.split('\n').map(x => str(x)).filter(Boolean);

  // 全被过滤光了：回退到原文，别让用户白发一条
  if (!lines.length && original) {
    const fallback = original.split('\n').map(x => str(x)).filter(Boolean);
    return { lines: fallback.slice(0, 4), filtered: true };
  }
  return { lines: lines.slice(0, 4), filtered: false };
}

/* ============================== 生成器 ============================== */

async function generateThreads(forceType = null) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const sc = scaleOf(config);
  const story = await storyBlock(ctx, config);

  const typeRule = forceType
    ? `所有帖子的 "type" 都必须是 "${forceType}"（${PLATFORM_NAMES[forceType]}）。`
    : `"type" 必须在 forum / tieba / weibo / xhs 之间混合。`;

  const prompt = `你是一个独立运行的"赛博网络社区服务器"。你的唯一任务是模拟随机网友发帖。
请生成 ${sc.threads} 条互不相关的帖子。${typeRule}
${story}
${distanceBlock(level)}

${PLATFORM_BLOCK}

${MOLE_RULE}
${recentTitles()}${knownHandles()}
【其他要求】
- ${postCountRule(sc)}
- 每条帖子 2-3 个 tags。
- 部分帖子带 vote，不需要就填 null。

只输出 JSON 数组，每个元素形如：
${THREAD_SCHEMA}`;

  const parsed = extractJson(await callAPI(prompt, tokenBudget(sc.threads, sc)), 'array');
  const list = (Array.isArray(parsed) ? parsed : [parsed])
    .map(x => sanitizeThread(x, forceType ? { type: forceType } : {}, sc))
    .filter(Boolean);
  if (!list.length) throw new Error('模型输出里没有可用的帖子');
  return list;
}

async function generateEvent() {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const sc = scaleOf(config);
  const story = await storyBlock(ctx, config);

  const prompt = `你是一个独立运行的"赛博网络社区服务器"。
这一次，请先定下**一件事**，然后让四个平台各自歪一遍它。
${story}
${distanceBlock(level)}

【同一件事，四个平台必须歪得不一样】
- weibo：营销号转述。标题党，【震惊】式夸张，情绪远大于事实，常提"图已经很糊了"。
- tieba：前几楼认真讨论，后面开始跑题吵架、玩梗，楼中楼互相嘴。
- xhs：包装成"避雷/指南/攻略"，emoji 排版，结尾软性引流。
- forum：长文梳理时间线，列点分析，语气很专业，但最终结论是错的。
四条帖子必须互相矛盾：同一个细节，不同平台说法不同。

【回复数量】${postCountRule(sc)}

${MOLE_RULE}
至多只在其中一条帖子里放 mole。
${knownHandles()}
只输出一个 JSON 对象：
{
  "event": { "title": "事件名（10字内）", "summary": "真实发生了什么，一句话。网友都不知道全貌" },
  "threads": [ 四条帖子，type 依次为 weibo、tieba、xhs、forum，结构如下 ]
}
帖子结构：
${THREAD_SCHEMA}`;

  const parsed = extractJson(await callAPI(prompt, tokenBudget(4, sc)), 'object');
  const ev = {
    id: makeId('e'),
    title: str(parsed?.event?.title) || '无名事件',
    summary: str(parsed?.event?.summary),
    stage: 0,
    createdAt: Date.now(),
  };

  const want = ['weibo', 'tieba', 'xhs', 'forum'];
  const threads = (Array.isArray(parsed?.threads) ? parsed.threads : [])
    .map((x, i) => sanitizeThread(x, {
      type: PLATFORMS.includes(x?.type) ? x.type : want[i] || 'forum',
      eventId: ev.id, eventTitle: ev.title, stage: 0,
    }, sc))
    .filter(Boolean);

  if (!threads.length) throw new Error('事件生成失败：没有拿到帖子');
  return { event: ev, threads };
}

async function fermentEvent(eventId) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const sc = scaleOf(config);
  const ev = findEvent(eventId);
  if (!ev) throw new Error('找不到这个事件');

  const nextStage = Math.min(3, (ev.stage ?? 0) + 1);
  const story = await storyBlock(ctx, config);

  const history = eventThreads(eventId).map(t =>
    `[${PLATFORM_NAMES[t.type]} · 第${(t.stage ?? 0) + 1}波] ${str(t.title)}｜${str(t.content).slice(0, 160)}`
  ).join('\n');

  const stageRule = [
    '',
    `【本波 · 回应】官方、权威、或当事方给出了一个说法，试图把事情定性。网友不买账，开始逐条挑刺。`,
    `【本波 · 爆料】自称知情人的账号放出了"细节"，和之前的官方说法互相矛盾。这一波吵得最凶，开始有人站队、有人被扒。`,
    `【本波 · 退潮】热度散了。只剩两三个人在翻旧账，语气疲惫。可以出现"有人删号了""当初那个爆料的号没了"。${level >= 1 ? '\n如果这个世界存在审查，可以把 "blocked" 设为 true，表示该话题已被屏蔽。' : ''}`,
  ][nextStage];

  const prompt = `你是一个独立运行的"赛博网络社区服务器"。一个旧事件正在继续发酵。
${story}
【事件】${ev.title}
【真相（只有你知道，网友依旧不掌握）】${ev.summary || '略'}

【之前已经出现过的帖子】
${history || '（无）'}

${stageRule}

${distanceBlock(level)}

${PLATFORM_BLOCK}
【回复数量】${postCountRule(sc)}

${MOLE_RULE}
${knownHandles()}
新帖必须**明确提到**之前那几波的内容（引用、反驳、或者嘲讽当初猜错的人）。

只输出 JSON 数组，含 1 到 2 条帖子，每个元素形如：
${THREAD_SCHEMA}
可以额外带 "blocked": true。`;

  const parsed = extractJson(await callAPI(prompt, tokenBudget(2, sc)), 'array');
  const threads = (Array.isArray(parsed) ? parsed : [parsed])
    .map(x => sanitizeThread(x, { eventId: ev.id, eventTitle: ev.title, stage: nextStage }, sc))
    .filter(Boolean);

  if (!threads.length) throw new Error('发酵失败：没有拿到新帖');
  return { threads, nextStage };
}

async function generateStir(thread, userText, alias) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const sc = scaleOf(config);
  const story = await storyBlock(ctx, config);

  const existing = (thread.posts || []).map((p, i) => `${i + 1}. ${p.author}${p.isUser ? '（就是我的小号）' : ''}：${p.content}`).join('\n');
  const lo = Math.max(1, sc.stir - 1);

  const prompt = `你是一个独立运行的"赛博网络社区服务器"。有人刚在一个帖子里插了一句话，请生成后续的网友反应。
${story}
【帖子】[${PLATFORM_NAMES[thread.type] || '论坛'}] ${str(thread.title)}
${str(thread.content)}

【已有回复】
${existing || '（无）'}

【刚刚插进来的发言】
${alias}：${userText}

${distanceBlock(level)}

【这一波反应的写法】
1. 生成 ${lo} 到 ${sc.stir} 条新回复（目标 ${sc.stir} 条），必须直接针对"${alias}"刚说的那句话。
2. 反应要有分歧：有人信，有人嘲，有人嫌他造谣，有人顺着往更离谱的方向推。
3. ${sc.replies > 0 ? `可以给其中一两条加楼中楼，每条不超过 ${sc.replies} 层。` : `不要生成楼中楼，"replies" 一律填 []。`}
4. ${level >= 1
    ? `如果"${alias}"说的东西太准、太像亲历者才知道的，就让其中一条回复起疑（"等一下，你怎么知道有车？"），并把那条的 "suspicious" 设为 true。至多一条。`
    : `不需要有人起疑，"suspicious" 全部填 false。`}
5. 禁止扮演故事里的角色，回复人全部是你捏造的路人网名。

只输出 JSON：
{ "posts": [ { "author": "网名", "content": "回复", "suspicious": false, "replies": [{ "author": "网名", "content": "楼中楼" }] } ] }`;

  const budget = Math.max(600, 400 + sc.stir * (95 + sc.replies * 32));
  const parsed = extractJson(await callAPI(prompt, budget), 'object');
  const posts = sanitizePosts(parsed?.posts, sc.stir + 1, sc.replies);
  if (!posts.length) throw new Error('没人理你（模型没给出回复）');
  return posts;
}

async function generateNecro(keyword) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const sc = scaleOf(config);
  const story = await storyBlock(ctx, config);
  const yearsAgo = 2 + Math.floor(Math.random() * 6);
  const year = new Date().getFullYear() - yearsAgo;

  const prompt = `你是一个独立运行的"赛博网络社区服务器"的**旧帖归档**。
有人搜索了关键词："${keyword}"，翻出了一个 ${yearsAgo} 年前的老帖。
${story}
${distanceBlock(level)}

【挖坟帖的写法】
1. 这是 ${year} 年发的帖子。当年有人问过和"${keyword}"几乎一样的事。
2. 那时候的网络用语、排版习惯要有年代感，提到的东西要是过去的。
3. 帖子必须是**断的**：楼主问到一半就再没出现过，或者最后一条回复停在一个很不安的地方。
4. 回复里要有人当年猜对了一部分，但被其他人嘲了。
5. ${postCountRule(sc)}
6. type 只能是 "forum" 或 "tieba"。

只输出一个 JSON 对象：
${THREAD_SCHEMA}
额外必须包含：
  "year": "${year}",
  "lastLogin": "楼主最后一次登录的日期，格式 ${year}-MM-DD",
  "deadEnd": "一句话说明这帖子为什么断在这里"`;

  const parsed = extractJson(await callAPI(prompt, tokenBudget(2, sc)), 'object');
  const t = sanitizeThread(Array.isArray(parsed) ? parsed[0] : parsed, {
    type: (parsed?.type === 'tieba') ? 'tieba' : 'forum',
    createdAt: Date.now() - yearsAgo * 365 * 24 * 3600 * 1000,
    isNecro: true,
  }, sc);
  if (!t) throw new Error('挖坟失败：没有拿到老帖');
  if (!t.necro) t.necro = { year: String(year), lastLogin: '', deadEnd: '' };
  t.tags = ['挖坟', keyword].concat(t.tags).slice(0, 4);
  return t;
}

async function generateDM(thread) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const story = await storyBlock(ctx, config);
  const alias = myAlias();

  const ctxLine = thread
    ? `他是在这个帖子里看见你的：\n[${PLATFORM_NAMES[thread.type]}] ${str(thread.title)}\n${str(thread.content).slice(0, 220)}`
    : '他不知道从哪翻到了你以前的发言。';

  const prompt = `你是一个独立运行的"赛博网络社区服务器"。有个网友私下找上了"${alias}"。
${story}
${ctxLine}

${distanceBlock(level)}

【私信的写法】
1. 这个人比帖子里所有人知道得多一点，但他**不会一次说完**。
2. 开场只说一两句，带钩子："你那条回复能删吗""你是不是也看见了"。
3. 语气是私下说话，谨慎、压低声音，不是公开发帖的腔调。
4. 他依旧是局外人，不是故事里的角色。禁止扮演已有角色。
5. 只输出纯文本对话，严禁动作描写和括号旁白。

只输出 JSON：
{ "author": "他的网名", "opening": "他发来的第一条私信", "knows": "他实际掌握的信息，一句话，之后的对话要和它一致" }`;

  const parsed = extractJson(await callAPI(prompt, 600), 'object');
  const opening = str(parsed?.opening);
  if (!opening) throw new Error('没人找你');
  return {
    id: makeId('d'),
    author: str(parsed?.author) || '陌生账号',
    knows: str(parsed?.knows),
    threadId: thread ? thread.id : null,
    threadTitle: thread ? (str(thread.title) || str(thread.content).slice(0, 20)) : '',
    messages: [{ who: 'them', text: opening, at: Date.now() }],
    unread: true,
    createdAt: Date.now(),
  };
}

async function continueDM(dm, userText) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const story = await storyBlock(ctx, config);
  const alias = myAlias();

  // 最后一条就是刚发出去的那句，单独放在下面，历史里不重复
  const log = dm.messages.slice(0, -1).slice(-10)
    .map(m => `${m.who === 'me' ? alias : dm.author}：${m.text}`).join('\n');

  const prompt = `你在扮演一个叫"${dm.author}"的网友，正在和"${alias}"私聊。
${story}
【你掌握的信息】${dm.knows || '你知道一些帖子里没说的细节，但来源不能说。'}

${distanceBlock(level)}

【对话规则】
1. 只回一条，一到三句。
2. 继续挤着不说完，透一点留一点。被追问就转移、犹豫、或者反问。
3. 你是局外人，禁止扮演故事里的角色。
4. 只输出纯文本，严禁动作描写、括号旁白、心理描写。

${log ? `【之前的对话】\n${log}\n` : ''}
【${alias} 刚刚发来】
${userText}

只输出 JSON：{ "reply": "你的回复" }`;

  const parsed = extractJson(await callAPI(prompt, 400), 'object');
  const reply = str(parsed?.reply);
  if (!reply) throw new Error('他没回');
  return reply;
}

async function generateBottle(type, userText = '') {
  const ctx = getContext();
  const config = getConfig();
  const story = await storyBlock(ctx, config);
  const level = distanceOf(config);

  const prompt = type === 'dredge'
    ? `你在扮演赛博网络世界里的一个随机网友。
${story}
${distanceBlock(level)}
你在赛博海洋里随手写了一张纸条，塞进漂流瓶扔了出去。
请直接输出纸条上的纯文本（20-50字），可以是求救、交友、碎碎念、吐槽，或者一条看不懂的信息。
格式严格如下：
网友名：XXX
内容：XXX`
    : `你在扮演赛博网络世界里的一个随机网友。
${story}
${distanceBlock(level)}
有人在赛博海洋里扔了一个漂流瓶，纸条上写着："${userText}"
你在海边捡到了它。请以这个网友的口吻回一句话。

【死命令】只输出纯文本，严禁动作描写。
格式：
网友名：XXX
内容：XXX`;

  const raw = await callAPI(prompt, 300);
  let author = '神秘网友';
  let text = raw;
  const nameMatch = raw.match(/网友名[：:]\s*(.+)/);
  const contentMatch = raw.match(/内容[：:]\s*([\s\S]+)/);
  if (nameMatch) author = str(nameMatch[1]);
  if (contentMatch) text = str(contentMatch[1]);
  else if (nameMatch) text = str(raw.replace(nameMatch[0], ''));
  if (!text) throw new Error('瓶子里是空的，再捞一次');
  return { author: author || '神秘网友', text };
}

/* ============================== 角色私聊生成 ============================== */

function fwdToText(snap) {
  let s = `[${PLATFORM_NAMES[snap.type] || '论坛'}] ${str(snap.title) || '（无标题）'}\n发帖人：${str(snap.author)}\n${str(snap.content)}`;
  if (Array.isArray(snap.posts) && snap.posts.length) {
    s += '\n回复：\n' + snap.posts.map(p => {
      let line = `· ${p.author}：${p.content}`;
      if (Array.isArray(p.replies) && p.replies.length) {
        line += '\n' + p.replies.map(r => `    └ ${r.author}：${r.content}`).join('\n');
      }
      return line;
    }).join('\n');
  }
  return s;
}

// 角色卡设定。budget 控制总长度，描述和说话范例优先保留
function charSheet(c, budget) {
  const d = c?.data || {};
  const pick = (a, b) => macro(a) || macro(b);
  const name = charName(c);

  const parts = [
    { tag: '描述', text: pick(d.description, c?.description), weight: 0.45 },
    { tag: '说话范例 · 必须模仿这个语气和用词习惯', text: pick(d.mes_example, c?.mes_example), weight: 0.3 },
    { tag: '性格', text: pick(d.personality, c?.personality), weight: 0.15 },
    { tag: '处境', text: pick(d.scenario, c?.scenario), weight: 0.1 },
  ].filter(p => p.text);

  let s = `【你要扮演的角色】${name}\n`;
  parts.forEach(p => {
    const cap = Math.max(300, Math.floor(budget * p.weight));
    const text = p.text.length > cap ? p.text.slice(0, cap) + '…' : p.text;
    s += `\n[${p.tag}]\n${text}\n`;
  });
  return s;
}

async function generateCharReply(ch, incoming, retake = false) {
  const ctx = getContext();
  const config = getConfig();
  const name = charName(ch);
  const user = userName();
  const chat = getChat(charKey(ch));

  // 按优先级分配字符预算：角色卡 > 历史 > 正文剧情 > 人设 > 世界书
  const sheet = charSheet(ch, Math.floor(CHAR_PROMPT_CAP * 0.42));
  let left = CHAR_PROMPT_CAP - sheet.length;

  // 最后一条消息就是本次的触发内容，下面会单独给出，历史里必须排除
  const histSrc = chat.messages.slice(0, -1);
  const histAll = histSrc.slice(-CHAR_HIST_MAX).map(m => {
    if (m.who === 'fwd') return `${user}（转发了一个帖子）：\n${fwdToText(m.snap).slice(0, 400)}`;
    return `${m.who === 'me' ? user : name}：${m.text}`;
  });

  let hist = '';
  let dropped = histSrc.length > histAll.length;
  for (let i = histAll.length - 1; i >= 0; i--) {
    const line = histAll[i] + '\n';
    if (hist && hist.length + line.length > Math.max(600, left * 0.3)) { dropped = true; break; }
    hist = line + hist;
  }
  if (dropped && hist) hist = '（更早的聊天略）\n' + hist;
  left -= hist.length;

  const storyCap = Math.max(500, Math.floor(left * 0.45));
  let story = recentChat(ctx, 10);
  if (story.length > storyCap) story = '（更早的剧情略）\n' + story.slice(-storyCap);
  left -= story.length;

  let persona = macro(ctx.powerUserSettings?.personas?.[ctx.name1] || ctx.powerUserSettings?.persona_description || '');
  const personaCap = Math.max(0, Math.floor(left * 0.35));
  if (persona.length > personaCap) persona = persona.slice(0, personaCap);
  left -= persona.length;

  let wi = '';
  if (left > 400) {
    wi = await worldBlock(ctx);
    if (wi.length > left) wi = wi.slice(0, left);
  }

  const incomingBlock = incoming.type === 'fwd'
    ? `【${user} 刚刚转发给你一个网上的帖子】
${fwdToText(incoming.snap)}

【关于这个帖子】
· 这是网上的陌生人在议论，他们掌握的信息是残缺的，有些说法是错的。
· 你知道真相（见上面的剧情）。你可以指出他们哪里说错了、哪里离得太近、或者根本没发现重点。
· 你的反应要符合你的性格：可能警觉、可能不屑、可能觉得好笑、可能立刻想到后果。`
    : `【${user} 刚刚发来】
${incoming.text}`;

  const prompt = `${sheet}
${persona ? `\n【${user} 的人设】\n${persona}\n` : ''}${wi ? `\n【世界观设定】\n${wi}\n` : ''}${config.customPrompt ? `\n【补充设定】\n${config.customPrompt}\n` : ''}
【你们在正文里刚刚经历的事（这是真实发生的，你知道全部）】
${story || '（还没有共同经历）'}

【当前场景 · 极其重要】
你和 ${user} 正在用手机上的聊天软件发消息。这不是小说，不是旁白，是真人在打字。

【输出规则 · 违反任何一条都算失败】
1. 只输出 ${name} 打出来的消息文字本身。
2. 严禁动作描写、神态描写、心理描写、环境描写。
3. 严禁括号旁白、星号包裹的动作（例如 *皱眉*）、冒号前缀、引号包裹。
4. 严禁替 ${user} 说话，严禁描写 ${user} 的反应。
5. 一次发 1 到 3 条短消息，每条单独一行。像真人发消息那样口语化，可以短、可以省略、可以用语气词和标点习惯。
6. 保持 ${name} 的性格、立场和说话习惯，和上面的说话范例一致。
7. 你只知道设定和剧情里出现过的信息，不要编造你不可能知道的事。

${hist ? `【你们之前的聊天记录】\n${hist}` : ''}
${incomingBlock}
${retake ? '\n（上一次的回复不理想，请换一个说法和角度重写）\n' : ''}
现在输出 ${name} 发来的消息（纯文本，每条一行，不要任何解释）：`;

  const raw = await callAPI(prompt, 500, retake ? 0.95 : 0.85, !!config.charUseST);
  const { lines, filtered } = cleanIM(raw, name);
  if (!lines.length) throw new Error('对方没说话（模型返回了空内容）');
  if (filtered) notify('warning', '模型输出里全是动作描写，已原样显示。角色卡的说话范例如果偏小说腔，会导致这种情况');
  return lines;
}

/* ============================== 渲染 ============================== */

function setBusy(on, label = '') {
  busy = on;
  busyLabel = on ? label : '';
  $('#forum_quick_gen').toggleClass('fa-spin', !!on);
}

function errorBannerHtml() {
  return `
    <div class="forum-error">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <div class="forum-error-body"><b>E R R O R</b><span>${escapeHtml(lastError)}</span></div>
      <i class="fa-solid fa-xmark forum-error-close" title="关闭"></i>
    </div>`;
}

function loadingHtml() {
  return `
    <div class="forum-loading">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <div class="forum-loading-body">
        <b>${escapeHtml(busyLabel || '生成中')}</b>
        <span>模型正在写，可能要等十几秒</span>
      </div>
    </div>`;
}

function emptyHtml() {
  if (currentEvent) {
    return `<div class="empty-state">
      <i class="fa-solid fa-globe"></i>
      <p>这个事件下没有帖子了</p>
      <div class="es-sub">E M P T Y &nbsp; T H R E A D</div>
      <button class="empty-btn filter-clear">返回全部</button>
    </div>`;
  }
  if (currentTag) {
    return `<div class="empty-state">
      <i class="fa-solid fa-hashtag"></i>
      <p>没有带 #${escapeHtml(currentTag)} 的帖子</p>
      <div class="es-sub">N O &nbsp; M A T C H</div>
      <button class="empty-btn filter-clear">返回全部</button>
    </div>`;
  }
  if (currentFilter === 'fav') {
    return `<div class="empty-state">
      <i class="fa-regular fa-star"></i>
      <p>还没有收藏的帖子</p>
      <div class="es-sub">N O &nbsp; B O O K M A R K S</div>
    </div>`;
  }
  return `<div class="empty-state">
    <i class="fa-solid fa-feather-pointed"></i>
    <p>这里还没有人说话</p>
    <div class="es-sub">I S S U E &nbsp; E M P T Y</div>
    <button class="empty-btn empty-gen">生成第一批帖子</button>
  </div>`;
}

function renderTrends() {
  const data = getData();
  const hidden = new Set(data.hidden.map(String));
  const counts = {};

  data.threads.forEach(t => {
    if (!t || hidden.has(String(t.id)) || !Array.isArray(t.tags)) return;
    t.tags.forEach(tag => { const k = str(tag); if (k) counts[k] = (counts[k] || 0) + 1; });
  });

  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b)).slice(0, 6);
  const $trends = $('#forum_trends');

  const chips = [];
  if (currentEvent) {
    const ev = findEvent(currentEvent);
    chips.push(`<span class="trend-item active">${escapeHtml(ev ? ev.title : '事件')}</span>`);
  }
  chips.push(...top.map(tag =>
    `<span class="trend-item${currentTag === tag ? ' active' : ''}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`));

  if (!top.length && !currentEvent && !currentTag) { $trends.empty().hide(); return; }

  const clear = (currentTag || currentEvent)
    ? `<span class="trend-item trend-clear" title="清除筛选"><i class="fa-solid fa-xmark"></i></span>` : '';

  $trends.html(`<span class="trend-label">T R E N D I N G</span>${chips.join('')}${clear}`).css('display', 'flex');
}

function cardHtml(t) {
  const mode = PLATFORMS.includes(t.type) ? t.type : 'forum';
  const id = escapeHtml(t.id);
  const cls = ['thread-card', `card-${mode}`];
  if (t.isNecro) cls.push('card-necro');
  if (t.blocked && !t.unblocked) cls.push('card-blocked');

  const actions = `
    <div class="card-actions">
      <i class="fa-solid fa-eye-slash card-hide-btn" data-id="${id}" title="不感兴趣"></i>
      <i class="fa-solid fa-trash-can card-delete-btn" data-id="${id}" title="删除"></i>
      <i class="${t.isFavorited ? 'fa-solid fa-star active' : 'fa-regular fa-star'} card-star-btn" data-id="${id}" title="收藏"></i>
    </div>`;

  const marks = [];
  if (t.eventId) {
    marks.push(`<span class="c-chip c-chip-event" data-event="${escapeHtml(t.eventId)}">${escapeHtml(t.eventTitle || '事件')} · 第${(t.stage ?? 0) + 1}波 ${escapeHtml(STAGE_NAMES[t.stage ?? 0] || '')}</span>`);
  }
  if (t.isNecro) {
    marks.push(`<span class="c-chip c-chip-necro">${escapeHtml(t.necro?.year || '')} 年的老帖</span>`);
  }
  if (t.mole && !t.mole.revealed) {
    marks.push(`<span class="c-chip c-chip-mole">这楼里有人不对劲</span>`);
  }
  const marksHtml = marks.length ? `<div class="c-marks">${marks.join('')}</div>` : '';

  const timeText = mode === 'weibo' && !t.isNecro ? `${timeAgo(t.createdAt)} 来自 iPhone` : timeAgo(t.createdAt);
  const lz = mode === 'tieba' ? ' <span class="tieba-lz">楼主</span>' : '';
  const header = `
    <div class="c-header">
      <div class="avatar">${initial(t.author)}</div>
      <div class="user-info">
        <div class="c-name">${escapeHtml(t.author)}${lz}</div>
        <div class="c-time">${escapeHtml(timeText)}</div>
      </div>
    </div>`;

  let title = str(t.title);
  if (title && !title.includes('【')) {
    if (mode === 'tieba') title = `【水贴】${title}`;
    else if (mode === 'forum') title = `【讨论】${title}`;
  }
  const titleHtml = title ? `<div class="c-title">${escapeHtml(title)}</div>` : '';

  if (t.blocked && !t.unblocked) {
    return `<div class="${cls.join(' ')}">${actions}${marksHtml}${titleHtml}
      <div class="blocked-box">
        <i class="fa-solid fa-ban"></i>
        <b>该话题已被屏蔽</b>
        <span>根据相关法律法规和政策<br>本页面内容不予展示</span>
        <button class="empty-btn unblock-btn" data-id="${id}">强行查看缓存</button>
      </div>
      ${header}</div>`;
  }

  const contentHtml = str(t.content) ? `<div class="c-content">${escapeHtml(t.content)}</div>` : '';

  const tagsHtml = (t.tags || []).length
    ? `<div class="c-tags">${t.tags.map(tag => `<span class="c-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';

  let voteHtml = '';
  if (t.vote && Array.isArray(t.vote.options) && t.vote.options.length) {
    voteHtml = `
      <div class="vote-box">
        <div class="vote-title">P O L L &nbsp;·&nbsp; ${escapeHtml(t.vote.question)}</div>
        ${t.vote.options.map(o => `
          <div class="vote-option">
            <div class="vote-progress" style="width:${clampPct(o.percentage)}%"></div>
            <span class="vote-text">${escapeHtml(o.text)}</span>
            <span class="vote-percent">${clampPct(o.percentage)}%</span>
          </div>`).join('')}
      </div>`;
  }

  const posts = t.posts || [];
  const moleIdx = t.mole && t.mole.revealed ? t.mole.postIndex : -1;

  const postsHtml = posts.map((p, i) => {
    const pcls = ['post-item'];
    if (mode === 'tieba') pcls.push('tieba-post');
    if (p.isUser) pcls.push('is-user');
    if (i === moleIdx) pcls.push('is-mole');
    return `
      <div class="${pcls.join(' ')}">
        ${mode === 'tieba' ? `<span class="floor-num">${i + 2}F</span>` : ''}
        <div class="post-avatar">${initial(p.author)}</div>
        <div class="post-body">
          <div class="post-author">
            ${escapeHtml(p.author)}
            ${p.isUser ? '<em class="tag-me">我的小号</em>' : ''}
            ${p.suspicious ? '<em class="tag-sus">在盯你</em>' : ''}
            ${i === moleIdx ? '<em class="tag-mole">不是路人</em>' : ''}
          </div>
          <div class="post-text">${escapeHtml(p.content)}</div>
          ${(p.replies || []).length ? `<div class="post-replies">${p.replies.map(r =>
            `<div class="reply-item"><b>${escapeHtml(r.author)}:</b> <span>${escapeHtml(r.content)}</span></div>`).join('')}</div>` : ''}
          ${i === moleIdx ? `<div class="mole-reveal">
            <b>I D E N T I T Y</b> ${escapeHtml(t.mole.identity)}
            ${t.mole.slip ? `<br><b>T H E &nbsp; S L I P</b> ${escapeHtml(t.mole.slip)}` : ''}
          </div>` : ''}
        </div>
      </div>`;
  }).join('');

  const postsWrapper = posts.length ? `<div class="c-posts">${postsHtml}</div>` : '';

  const stirHtml = stirOpenId === String(t.id) ? `
    <div class="stir-box">
      <div class="stir-tip">以「${escapeHtml(myAlias())}」的身份插一句</div>
      <textarea class="stir-input" rows="2" placeholder="说点什么，可以是真话，也可以是假的…">${escapeHtml(stirDraft)}</textarea>
      <div class="stir-btns">
        <button class="btn-ghost stir-cancel">取消</button>
        <button class="stir-send" data-id="${id}">发出去</button>
      </div>
    </div>` : '';

  const extraBtns = [];
  if (t.mole && !t.mole.revealed) {
    extraBtns.push(`<span class="act-btn mole-btn" data-id="${id}">这谁？</span>`);
  }
  if (t.eventId) {
    const newest = newestOfEvent(t.eventId);
    if (newest && String(newest.id) === String(t.id) && (t.stage ?? 0) < 3) {
      extraBtns.push(`<span class="act-btn ferment-btn" data-event="${escapeHtml(t.eventId)}">让它发酵</span>`);
    }
  }
  extraBtns.push(`<span class="act-btn stir-btn" data-id="${id}">带节奏</span>`);
  extraBtns.push(`<span class="act-btn fwd-btn" data-id="${id}">给TA看</span>`);

  const commentCount = posts.length + posts.reduce((n, p) => n + (p.replies || []).length, 0);
  const actionBar = `
    <div class="action-bar">
      ${extraBtns.join('')}
      <span class="act-static"><i class="fa-solid fa-comment"></i> ${commentCount}</span>
      <span class="like-btn${t.isLiked ? ' liked' : ''}" data-id="${id}">
        <i class="${t.isLiked ? 'fa-solid fa-heart' : 'fa-regular fa-heart'}"></i> ${Number(t.likes) || 0}
      </span>
    </div>`;

  const necroFoot = t.isNecro && t.necro ? `
    <div class="necro-foot">
      ${t.necro.lastLogin ? `L A S T &nbsp; S E E N &nbsp;·&nbsp; ${escapeHtml(t.necro.lastLogin)}` : 'L A S T &nbsp; S E E N &nbsp;·&nbsp; 失联'}
      ${t.necro.deadEnd ? `<span>${escapeHtml(t.necro.deadEnd)}</span>` : ''}
    </div>` : '';

  return `<div class="${cls.join(' ')}">${actions}${marksHtml}${titleHtml}${contentHtml}${voteHtml}${tagsHtml}${header}${postsWrapper}${necroFoot}${stirHtml}${actionBar}</div>`;
}

function render() {
  const $list = $('#forum_list');
  if (!$list.length) return;

  const data = normalize(getData());

  $('#forum_panel .filter-pill').removeClass('active');
  $(`#forum_panel .filter-pill[data-filter="${currentFilter}"]`).addClass('active');
  renderTrends();
  renderBadge();

  const hidden = new Set(data.hidden.map(String));
  let threads = data.threads.filter(t => !hidden.has(String(t.id)));

  if (currentFilter === 'fav') threads = threads.filter(t => t.isFavorited);
  else if (currentFilter !== 'all') threads = threads.filter(t => (PLATFORMS.includes(t.type) ? t.type : 'forum') === currentFilter);

  if (currentTag) threads = threads.filter(t => Array.isArray(t.tags) && t.tags.some(x => str(x) === currentTag));
  if (currentEvent) threads = threads.filter(t => String(t.eventId || '') === String(currentEvent));

  const scroll = $list.scrollTop();
  const head = (lastError ? errorBannerHtml() : '') + (busy ? loadingHtml() : '');
  const body = threads.length ? threads.slice().reverse().map(cardHtml).join('') : (busy ? '' : emptyHtml());
  $list.html(head + body);
  $list.scrollTop(scroll);
}

function renderBadge() {
  const n = unreadDM();
  const $b = $('#forum_msg_badge');
  if (n > 0) $b.text(n > 9 ? '9+' : n).show(); else $b.hide();
}

/* ============================== 角色私聊渲染 ============================== */

function faceInner(c) {
  const url = charAvatarUrl(c);
  return url ? `<img src="${escapeHtml(url)}" alt="">` : initial(charName(c));
}

function faceHtml(c) {
  return `<div class="char-face">${faceInner(c)}</div>`;
}

function fwdCardHtml(snap) {
  const posts = (snap.posts || []).slice(0, 3);
  return `
    <div class="fwd-card">
      <div class="fwd-kicker">转发 · ${escapeHtml(PLATFORM_NAMES[snap.type] || '论坛')}</div>
      ${str(snap.title) ? `<div class="fwd-title">${escapeHtml(snap.title)}</div>` : ''}
      <div class="fwd-text">${escapeHtml(snap.content)}</div>
      ${posts.length ? `<div class="fwd-posts">${posts.map(p =>
        `<div><b>${escapeHtml(p.author)}:</b> ${escapeHtml(p.content)}</div>`).join('')}</div>` : ''}
    </div>`;
}

function renderCharList() {
  const chars = getChars();
  const $list = $('#char_list');

  if (!chars.length) {
    $list.html(`<div class="empty-state">
      <i class="fa-regular fa-id-badge"></i>
      <p>当前聊天里没有角色</p>
      <div class="es-sub">先在 SillyTavern 打开一张角色卡</div>
    </div>`);
    return;
  }

  $list.html(chars.map(c => {
    const key = charKey(c);
    const chat = getData().chats[key];
    const n = chat?.messages?.length || 0;
    const last = n ? chat.messages[n - 1] : null;
    const preview = last
      ? (last.who === 'fwd' ? '[转发了一个帖子]' : str(last.text).slice(0, 40))
      : '还没聊过';
    return `
      <button class="char-row" data-key="${escapeHtml(key)}">
        ${faceHtml(c)}
        <span class="char-row-body">
          <b>${escapeHtml(charName(c))}</b>
          <span>${escapeHtml(preview)}</span>
        </span>
        ${n ? `<span class="char-row-count">${n}</span>` : ''}
        <i class="fa-solid fa-arrow-right"></i>
      </button>`;
  }).join(''));
}

function renderCharChat(pending = false) {
  const ch = findCharByKey(activeChar);
  if (!ch) { showCharList(); return; }

  const name = charName(ch);
  $('#char_avatar').html(faceInner(ch));   // 只换内容，不替换节点，否则 id 会丢
  $('#char_chat_name').text(name);
  $('#char_chat_sub').text('插件内的私聊，不会写进正文');

  const chat = getChat(activeChar);
  const lastIdx = chat.messages.length - 1;

  const body = chat.messages.map((m, i) => {
    if (m.who === 'fwd') {
      return `<div class="dm-msg mine"><div class="dm-bubble has-fwd">${fwdCardHtml(m.snap)}</div></div>`;
    }
    const retake = (!pending && m.who === 'them' && i === lastIdx)
      ? `<div class="msg-tools"><span class="retake-btn"><i class="fa-solid fa-rotate-right"></i> 重新生成</span></div>`
      : '';
    return `<div class="dm-msg ${m.who === 'me' ? 'mine' : 'theirs'}">
      <div class="dm-msg-col"><div class="dm-bubble">${escapeHtml(m.text)}</div>${retake}</div>
    </div>`;
  }).join('');

  const typing = pending
    ? `<div class="dm-msg theirs"><div class="dm-bubble dm-typing"><i class="fa-solid fa-spinner fa-spin"></i> 正在输入…</div></div>`
    : '';

  const empty = (!chat.messages.length && !pending)
    ? `<div class="empty-state">
        <i class="fa-regular fa-comments"></i>
        <p>还没和 ${escapeHtml(name)} 聊过</p>
        <div class="es-sub">在帖子上点「给TA看」把网上的传闻转发过来</div>
      </div>`
    : '';

  $('#char_messages').html(empty + body + typing);
  const el = document.getElementById('char_messages');
  if (el) el.scrollTop = el.scrollHeight;
}

function showCharList() {
  activeChar = null;
  $('#char_chat_view').hide();
  $('#char_list_view').css('display', 'flex');
  renderCharList();
}

function openChar(key) {
  const ch = findCharByKey(key);
  if (!ch) return;
  activeChar = charKey(ch);
  getChat(activeChar);
  $('#char_list_view').hide();
  $('#char_chat_view').css('display', 'flex');
  renderCharChat();
}

/* ============================== 陌生网友私信渲染 ============================== */

function renderDMList() {
  const dms = getData().dms.slice().sort((a, b) => (b.messages.at(-1)?.at || 0) - (a.messages.at(-1)?.at || 0));
  const loading = busy && busyLabel === '捞私信' ? loadingHtml() : '';

  if (!dms.length) {
    $('#dm_list').html(loading || `<div class="empty-state">
      <i class="fa-regular fa-envelope"></i>
      <p>还没有人私下找你</p>
      <div class="es-sub">在帖子里带过节奏之后更容易被盯上</div>
    </div>`);
    return;
  }

  $('#dm_list').html(loading + dms.map(d => {
    const last = d.messages.at(-1);
    return `
      <div class="dm-item${d.unread ? ' unread' : ''}" data-id="${escapeHtml(d.id)}">
        <div class="post-avatar">${initial(d.author)}</div>
        <div class="dm-item-body">
          <div class="dm-item-top">
            <b>${escapeHtml(d.author)}</b>
            <span>${escapeHtml(timeAgo(last?.at))}</span>
          </div>
          <div class="dm-item-last">${last?.who === 'me' ? '我：' : ''}${escapeHtml(str(last?.text).slice(0, 44))}</div>
          ${d.threadTitle ? `<div class="dm-item-from">来自：${escapeHtml(d.threadTitle)}</div>` : ''}
        </div>
        ${d.unread ? '<em class="dm-dot"></em>' : ''}
        <i class="fa-solid fa-trash-can dm-del" data-id="${escapeHtml(d.id)}" title="删除"></i>
      </div>`;
  }).join(''));
}

function renderDMChat(pending = false) {
  const dm = getData().dms.find(d => String(d.id) === String(activeDM));
  if (!dm) { showDMList(); return; }
  $('#dm_chat_name').text(dm.author);
  $('#dm_chat_from').text(dm.threadTitle ? `在「${dm.threadTitle}」看见你的` : '');

  const typing = pending
    ? `<div class="dm-msg theirs"><div class="dm-bubble dm-typing"><i class="fa-solid fa-spinner fa-spin"></i> 正在输入…</div></div>`
    : '';

  $('#dm_messages').html(dm.messages.map(m =>
    `<div class="dm-msg ${m.who === 'me' ? 'mine' : 'theirs'}"><div class="dm-bubble">${escapeHtml(m.text)}</div></div>`
  ).join('') + typing);

  const el = document.getElementById('dm_messages');
  if (el) el.scrollTop = el.scrollHeight;
}

function showDMList() {
  activeDM = null;
  $('#dm_chat_view').hide();
  $('#dm_list_view').css('display', 'flex');
  renderDMList();
}

function openDM(id) {
  const dm = getData().dms.find(d => String(d.id) === String(id));
  if (!dm) return;
  if (dm.unread) { dm.unread = false; saveAll(); renderBadge(); }
  activeDM = dm.id;
  $('#dm_list_view').hide();
  $('#dm_chat_view').css('display', 'flex');
  renderDMChat();
}

/* ============================== 动作 ============================== */

// fn 收到一个取数函数。必须在 await 之后才调它：
// 它会校验聊天没被切换，再返回当前聊天的数据，避免写进别的聊天
async function run(label, fn) {
  if (anyBusy()) { notify('info', '上一个还在跑'); return; }
  const token = chatToken();
  setBusy(true, label);
  lastError = null;
  render();
  try {
    await fn(() => {
      if (chatToken() !== token) throw new Error('聊天已经切换，这次生成的内容已丢弃');
      return getData();
    }, token);
  } catch (e) {
    console.error(`[幻境社区] ${label}失败`, e);
    lastError = `${label}：${e?.message || e}`;
    notify('error', lastError);
  } finally {
    setBusy(false);
    render();
  }
}

function actGenerate() {
  return run('刷新', async (data) => {
    const forceType = PLATFORMS.includes(currentFilter) ? currentFilter : null;
    const threads = await generateThreads(forceType);
    const d = data();
    d.threads.push(...threads);
    currentTag = null;
    currentEvent = null;
    saveAll();
    notify('success', `新增 ${threads.length} 条帖子`);
    $('#forum_list').scrollTop(0);
  });
}

function actEvent() {
  return run('造事件', async (data) => {
    const { event, threads } = await generateEvent();
    const d = data();
    d.events.push(event);
    d.threads.push(...threads);
    currentTag = null;
    currentFilter = 'all';
    currentEvent = event.id;
    saveAll();
    notify('success', `「${event.title}」· ${threads.length} 个平台`);
    $('#forum_list').scrollTop(0);
  });
}

function actFerment(eventId) {
  return run('发酵', async (data) => {
    const { threads, nextStage } = await fermentEvent(eventId);
    const d = data();
    d.threads.push(...threads);
    const ev = d.events.find(e => String(e.id) === String(eventId));
    if (ev) ev.stage = nextStage;
    currentEvent = eventId;
    currentTag = null;
    saveAll();
    notify('success', `第${nextStage + 1}波：${STAGE_NAMES[nextStage]}`);
    $('#forum_list').scrollTop(0);
  });
}

function actNecro(keyword) {
  return run('挖坟', async (data) => {
    const t = await generateNecro(keyword);
    const d = data();
    d.threads.push(t);
    currentTag = null;
    currentEvent = null;
    currentFilter = 'all';
    saveAll();
    notify('success', '翻出来一个老帖');
    $('#forum_list').scrollTop(0);
  });
}

function actStir(threadId, text) {
  return run('带节奏', async (data, token) => {
    const t = findThread(threadId);
    if (!t) throw new Error('帖子不见了');

    const alias = myAlias();
    const preview = { ...t, posts: [...(t.posts || []), { author: alias, content: text, isUser: true, replies: [] }] };
    const posts = await generateStir(preview, text, alias);

    const d = data();
    const fresh = d.threads.find(x => String(x.id) === String(threadId));
    if (!fresh) throw new Error('帖子不见了');
    fresh.posts = fresh.posts || [];
    fresh.posts.push({ author: alias, content: text, isUser: true, replies: [] });
    fresh.posts.push(...posts);
    fresh.likes = Math.max(0, (Number(fresh.likes) || 0) + Math.floor(Math.random() * 40));

    stirOpenId = null;
    stirDraft = '';
    saveAll();

    // 私信是附带产物，失败不影响上面已保存的回复。
    // 先判断该不该生成，再 await，否则下面的 data() 抛错会被 catch 吞掉，私信静默丢失
    const level = distanceOf(getConfig());
    const suspected = posts.some(p => p.suspicious);
    if (level < 1 || (!suspected && Math.random() >= 0.3)) return;

    try {
      const dm = await generateDM(fresh);
      if (chatToken() !== token) { console.warn('[幻境社区] 聊天已切换，附带私信丢弃'); return; }
      getData().dms.push(dm);
      saveAll();
      notify('info', `${dm.author} 私信了你`);
    } catch (e) {
      console.warn('[幻境社区] 附带私信没生成出来', e);
    }
  });
}

function actFetchDM() {
  return run('捞私信', async (data) => {
    const pool = getData().threads.filter(t => (t.posts || []).some(p => p.isUser));
    const thread = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    const dm = await generateDM(thread);
    data().dms.push(dm);
    saveAll();
    notify('success', `${dm.author} 找你`);
  });
}

async function sendToChar(key, incoming) {
  if (anyBusy()) { notify('info', '上一个还在跑'); return; }
  const ch = findCharByKey(key);
  if (!ch) { notify('warning', '找不到这个角色'); return; }

  const token = chatToken();
  const chat = getChat(key);
  chat.messages.push(incoming.type === 'fwd'
    ? { who: 'fwd', snap: incoming.snap, threadId: incoming.threadId || null, at: Date.now() }
    : { who: 'me', text: incoming.text, at: Date.now() });
  saveAll();

  imBusy = true;
  $('#char_send').prop('disabled', true).text('…');
  renderCharChat(true);

  try {
    const lines = await generateCharReply(ch, incoming);
    if (chatToken() !== token) { notify('warning', '聊天已经切换，这条回复没有保存'); return; }
    const fresh = getChat(key);   // await 之后重新取，不复用旧引用
    lines.forEach(line => fresh.messages.push({ who: 'them', text: line, at: Date.now() }));
    saveAll();
  } catch (e) {
    console.error('[幻境社区] 角色回复失败', e);
    notify('error', '对方没回：' + (e?.message || e));
  } finally {
    imBusy = false;
    $('#char_send').prop('disabled', false).text('发送');
    renderCharChat();
  }
}

// 重新生成最后一次回复。把上一轮角色说的话全部撤掉再重来
async function retakeChar() {
  if (anyBusy()) { notify('info', '上一个还在跑'); return; }
  if (!activeChar) return;
  const key = activeChar;
  const ch = findCharByKey(key);
  if (!ch) { notify('warning', '找不到这个角色'); return; }

  retakeLock = true;
  const token = chatToken();
  let removed = [];
  let incoming = null;

  try {
    const chat = getChat(key);
    while (chat.messages.length && chat.messages.at(-1).who === 'them') removed.push(chat.messages.pop());
    if (!removed.length) return;
    removed.reverse();   // 恢复原本顺序，失败时按原样放回

    const trigger = chat.messages.at(-1);
    if (!trigger) {
      chat.messages.push(...removed);
      notify('warning', '没有可以重新生成的消息');
      renderCharChat();
      return;
    }

    incoming = trigger.who === 'fwd'
      ? { type: 'fwd', snap: trigger.snap, threadId: trigger.threadId }
      : { type: 'text', text: trigger.text };

    imBusy = true;
  } finally {
    retakeLock = false;   // 置位完成，之后由 imBusy 接管
  }

  if (!incoming) return;

  $('#char_send').prop('disabled', true);
  renderCharChat(true);

  try {
    const lines = await generateCharReply(ch, incoming, true);
    if (chatToken() !== token) { notify('warning', '聊天已经切换，这次重新生成已丢弃'); return; }
    const fresh = getChat(key);   // await 之后重新取
    lines.forEach(line => fresh.messages.push({ who: 'them', text: line, at: Date.now() }));
    saveAll();
  } catch (e) {
    console.error('[幻境社区] 重新生成失败', e);
    if (chatToken() === token) {
      getChat(key).messages.push(...removed);
      saveAll();
    }
    notify('error', '重新生成失败：' + (e?.message || e));
  } finally {
    imBusy = false;
    $('#char_send').prop('disabled', false);
    renderCharChat();
  }
}

function forwardThread(threadId, key) {
  const t = findThread(threadId);
  if (!t) { notify('warning', '帖子不见了'); return; }
  if (!findCharByKey(key)) { notify('warning', '找不到这个角色'); return; }
  if (anyBusy()) { notify('info', '上一个还在跑'); return; }

  const sc = scaleOf(getConfig());
  const snap = {
    type: t.type,
    title: str(t.title),
    author: str(t.author),
    content: str(t.content),
    posts: (t.posts || []).slice(0, 4).map(p => ({
      author: str(p.author),
      content: str(p.content),
      replies: (p.replies || []).slice(0, Math.max(2, sc.replies)).map(r => ({ author: str(r.author), content: str(r.content) })),
    })),
  };

  $('#forum_gen_sheet, #forum_char_pick, #forum_modal_overlay').hide();
  $('#forum_main_view').hide();
  $('#forum_msg_panel').css('display', 'flex');
  switchMsgTab('char', true);   // 只切面板，别自动打开上一个角色
  openChar(key);
  sendToChar(key, { type: 'fwd', snap, threadId: t.id });
}

function openFwdPicker(threadId) {
  const chars = getChars();
  if (!chars.length) { notify('warning', '当前聊天里没有角色，先打开一张角色卡'); return; }
  if (chars.length === 1) { forwardThread(threadId, charKey(chars[0])); return; }

  pendingFwd = threadId;
  $('#char_pick_list').html(chars.map(c => `
    <button class="char-pick-row" data-key="${escapeHtml(charKey(c))}">
      ${faceHtml(c)}
      <b>${escapeHtml(charName(c))}</b>
      <i class="fa-solid fa-arrow-right"></i>
    </button>`).join(''));
  $('#forum_char_pick').css('display', 'flex');
}

/* ============================== 位置与尺寸 ============================== */

function panelEl() { return document.getElementById('forum_panel'); }

function clampSize(w, h, left, top) {
  const panel = panelEl();
  const rect = panel.getBoundingClientRect();
  const l = Number.isFinite(left) ? left : rect.left;
  const t = Number.isFinite(top) ? top : rect.top;
  const maxW = Math.max(MIN_W, window.innerWidth - l - EDGE);
  const maxH = Math.max(MIN_H, window.innerHeight - t - EDGE);
  return {
    w: Math.min(Math.max(Number(w) || MIN_W, MIN_W), maxW),
    h: Math.min(Math.max(Number(h) || MIN_H, MIN_H), maxH),
  };
}

function clampPos(left, top) {
  const panel = panelEl();
  const maxLeft = Math.max(EDGE, window.innerWidth - panel.offsetWidth - EDGE);
  const maxTop = Math.max(EDGE, window.innerHeight - panel.offsetHeight - EDGE);
  return {
    left: Math.min(Math.max(Number(left) || 0, EDGE), maxLeft),
    top: Math.min(Math.max(Number(top) || 0, EDGE), maxTop),
  };
}

function savePos(left, top) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ left, top })); } catch (e) { /* 忽略 */ }
}

function saveSize(w, h) {
  try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h })); } catch (e) { /* 忽略 */ }
}

function applySize(w, h) {
  const panel = panelEl();
  const c = clampSize(w, h);
  panel.style.width = `${c.w}px`;
  panel.style.height = `${c.h}px`;
  panel.style.maxWidth = 'none';
  return c;
}

function applySavedGeometry() {
  const panel = panelEl();
  if (!panel) return;

  let size = null;
  try { size = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'); } catch (e) { /* 忽略 */ }
  if (size && Number.isFinite(size.w) && Number.isFinite(size.h)) applySize(size.w, size.h);

  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
  if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
    const c = clampPos(pos.left, pos.top);
    panel.style.left = `${c.left}px`;
    panel.style.top = `${c.top}px`;
  }
}

function resetGeometry() {
  const panel = panelEl();
  if (!panel) return;
  panel.style.left = '';
  panel.style.top = '';
  panel.style.width = '';
  panel.style.height = '';
  panel.style.maxWidth = '';
  try { localStorage.removeItem(POS_KEY); localStorage.removeItem(SIZE_KEY); } catch (e) { /* 忽略 */ }
  notify('info', '窗口已还原到默认大小和位置');
}

const NO_DRAG = '.hd-btn, .hd-primary, .app-close, .app-filters, .app-trends, .trend-item, .filter-pill, button, input, textarea, select, a, [contenteditable]';

function bindDrag() {
  const panel = panelEl();
  const handle = document.getElementById('forum_drag_handle');
  if (!panel || !handle) return;

  let dragging = false;
  let startX = 0, startY = 0, baseX = 0, baseY = 0, lastX = 0, lastY = 0;

  const start = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    if (e.target.closest(NO_DRAG)) return;
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX; startY = p.clientY;
    const rect = panel.getBoundingClientRect();
    baseX = rect.left; baseY = rect.top;
    lastX = baseX; lastY = baseY;
  };

  const move = (e) => {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    const c = clampPos(baseX + (p.clientX - startX), baseY + (p.clientY - startY));
    lastX = c.left; lastY = c.top;
    panel.style.left = `${c.left}px`;
    panel.style.top = `${c.top}px`;
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    savePos(lastX, lastY);
  };

  handle.addEventListener('mousedown', start);
  handle.addEventListener('touchstart', start, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
}

function bindResize() {
  const panel = panelEl();
  const grip = document.getElementById('forum_resize');
  if (!panel || !grip) return;

  let sizing = false;
  let startX = 0, startY = 0, baseW = 0, baseH = 0, lastW = 0, lastH = 0;

  const start = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    sizing = true;
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX; startY = p.clientY;
    baseW = panel.offsetWidth; baseH = panel.offsetHeight;
    lastW = baseW; lastH = baseH;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  };

  const move = (e) => {
    if (!sizing) return;
    if (e.cancelable) e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    const c = applySize(baseW + (p.clientX - startX), baseH + (p.clientY - startY));
    lastW = c.w; lastH = c.h;
  };

  const end = () => {
    if (!sizing) return;
    sizing = false;
    saveSize(lastW, lastH);
  };

  grip.addEventListener('mousedown', start);
  grip.addEventListener('touchstart', start, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
}

function bindWindowResize() {
  const panel = panelEl();
  if (!panel) return;
  let timer = null;

  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (panel.style.display === 'none') return;
      if (panel.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;

      if (panel.style.width) {
        const c = applySize(parseFloat(panel.style.width), parseFloat(panel.style.height));
        saveSize(c.w, c.h);
      }
      if (panel.style.left) {
        const c = clampPos(parseFloat(panel.style.left), parseFloat(panel.style.top));
        panel.style.left = `${c.left}px`;
        panel.style.top = `${c.top}px`;
        savePos(c.left, c.top);
      }
    }, 150);
  });
}

/* ============================== 事件绑定 ============================== */

function openPanel() {
  // 没有聊天时数据写进 detachedStore，不存盘。每次打开清一次，免得越积越多
  if (getData() === detachedStore) {
    detachedStore.threads = [];
    detachedStore.hidden = [];
    detachedStore.events = [];
    detachedStore.dms = [];
    detachedStore.chats = {};
  }
  $('#forum_panel').css('display', 'flex');
  $('#forum_msg_panel, #forum_modal_overlay, #forum_gen_sheet, #forum_char_pick').hide();
  $('#forum_main_view').css('display', 'flex');
  applySavedGeometry();
  render();
}

function syncDistanceUI(v) {
  $('#forum_distance .seg-item').removeClass('active');
  $(`#forum_distance .seg-item[data-v="${v}"]`).addClass('active');
  $('#forum_distance_hint').html(Number(v) >= 1
    ? '会自动读取最近聊天记录当素材。网友说的话有一半是错的，这是故意的。'
    : '不读故事，纯背景噪音。');
  $('#forum_read_chat').prop('disabled', Number(v) >= 1);
  $('#forum_read_chat').closest('.set-check').toggleClass('locked', Number(v) >= 1);
}

function switchMsgTab(tab, skipAuto = false) {
  msgTab = ['char', 'dm', 'bottle'].includes(tab) ? tab : 'char';
  $('#forum_panel .msg-tab').removeClass('active');
  $(`#forum_panel .msg-tab[data-tab="${msgTab}"]`).addClass('active');
  $('#msg_tab_char').css('display', msgTab === 'char' ? 'flex' : 'none');
  $('#msg_tab_dm').css('display', msgTab === 'dm' ? 'flex' : 'none');
  $('#msg_tab_bottle').css('display', msgTab === 'bottle' ? 'flex' : 'none');
  if (skipAuto) return;

  if (msgTab === 'char') {
    const chars = getChars();
    if (activeChar && findCharByKey(activeChar)) openChar(activeChar);
    else if (chars.length === 1) openChar(charKey(chars[0]));
    else showCharList();
  }
  if (msgTab === 'dm' && !activeDM) showDMList();
}

function bindEvents() {
  bindDrag();
  bindResize();
  bindWindowResize();

  /* ---------- 面板开关 ---------- */
  $(document).on('click', '#forum_menu_btn', () => {
    const $p = $('#forum_panel');
    if ($p.is(':visible')) $p.hide(); else openPanel();
  });
  $(document).on('click', '#forum_close_btn', () => $('#forum_panel').hide());
  $(document).on('dblclick', '#forum_drag_handle .mast-left', resetGeometry);
  $(document).on('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#forum_panel').is(':visible')) return;
    if ($('#forum_modal_overlay').is(':visible')) { $('#forum_modal_overlay').hide(); return; }
    if ($('#forum_char_pick').is(':visible')) { $('#forum_char_pick').hide(); pendingFwd = null; return; }
    if ($('#forum_gen_sheet').is(':visible')) { $('#forum_gen_sheet').hide(); return; }
    if ($('#forum_msg_panel').is(':visible')) { $('#forum_msg_panel').hide(); $('#forum_main_view').css('display', 'flex'); return; }
    $('#forum_panel').hide();
  });

  /* ---------- 生成 ---------- */
  $(document).on('click', '#forum_quick_gen', () => actGenerate());
  $(document).on('click', '#forum_panel .empty-btn.empty-gen', () => actGenerate());
  $(document).on('click', '#forum_open_gen', () => $('#forum_gen_sheet').css('display', 'flex'));
  $(document).on('click', '#gen_sheet_close', () => $('#forum_gen_sheet').hide());
  $(document).on('click', '#forum_gen_sheet', function (e) { if (e.target === this) $(this).hide(); });

  $(document).on('click', '#gen_mixed', () => { $('#forum_gen_sheet').hide(); actGenerate(); });
  $(document).on('click', '#gen_event', () => { $('#forum_gen_sheet').hide(); actEvent(); });
  $(document).on('click', '#gen_necro', () => {
    const kw = str($('#necro_input').val());
    if (!kw) { notify('warning', '先写个关键词'); return; }
    if (anyBusy()) { notify('info', '上一个还在跑'); return; }
    $('#necro_input').val('');
    $('#forum_gen_sheet').hide();
    actNecro(kw);
  });
  $(document).on('keydown', '#necro_input', e => { if (e.key === 'Enter') { e.preventDefault(); $('#gen_necro').trigger('click'); } });

  $(document).on('click', '#forum_panel .ferment-btn', function (e) {
    e.stopPropagation();
    actFerment($(this).attr('data-event'));
  });

  /* ---------- 筛选 ---------- */
  $(document).on('click', '#forum_panel .filter-pill', function () {
    currentFilter = String($(this).attr('data-filter') || 'all');
    render();
    $('#forum_list').scrollTop(0);
  });
  $(document).on('click', '#forum_panel .trend-item, #forum_panel .c-tag', function (e) {
    e.stopPropagation();
    if ($(this).hasClass('trend-clear')) { currentTag = null; currentEvent = null; render(); return; }
    const tag = str($(this).attr('data-tag'));
    if (!tag) return;
    currentEvent = null;
    currentTag = currentTag === tag ? null : tag;
    render();
    $('#forum_list').scrollTop(0);
  });
  $(document).on('click', '#forum_panel .c-chip-event', function (e) {
    e.stopPropagation();
    const id = $(this).attr('data-event');
    currentTag = null;
    currentEvent = String(currentEvent) === String(id) ? null : id;
    render();
    $('#forum_list').scrollTop(0);
  });
  $(document).on('click', '#forum_panel .empty-btn.filter-clear', () => {
    currentTag = null; currentEvent = null; currentFilter = 'all'; render();
  });
  $(document).on('click', '#forum_panel .forum-error-close', () => { lastError = null; render(); });

  /* ---------- 卡片操作 ---------- */
  $(document).on('click', '#forum_panel .like-btn', function (e) {
    e.stopPropagation();
    const t = findThread($(this).attr('data-id'));
    if (!t) return;
    t.isLiked = !t.isLiked;
    t.likes = Math.max(0, (Number(t.likes) || 0) + (t.isLiked ? 1 : -1));
    saveAll();
    $(this).toggleClass('liked', t.isLiked)
      .html(`<i class="${t.isLiked ? 'fa-solid' : 'fa-regular'} fa-heart"></i> ${t.likes}`);
  });

  $(document).on('click', '#forum_panel .card-star-btn', function (e) {
    e.stopPropagation();
    const t = findThread($(this).attr('data-id'));
    if (!t) return;
    t.isFavorited = !t.isFavorited;
    saveAll();
    if (currentFilter === 'fav') { render(); return; }
    $(this).toggleClass('active', t.isFavorited)
      .toggleClass('fa-solid', t.isFavorited)
      .toggleClass('fa-regular', !t.isFavorited);
  });

  $(document).on('click', '#forum_panel .card-hide-btn', function (e) {
    e.stopPropagation();
    const id = String($(this).attr('data-id'));
    const data = getData();
    if (!data.hidden.map(String).includes(id)) data.hidden.push(id);
    saveAll();
    render();
  });

  $(document).on('click', '#forum_panel .card-delete-btn', function (e) {
    e.stopPropagation();
    const id = String($(this).attr('data-id'));
    const data = getData();
    data.threads = data.threads.filter(t => String(t.id) !== id);
    data.hidden = data.hidden.map(String).filter(x => x !== id);
    if (stirOpenId === id) { stirOpenId = null; stirDraft = ''; }
    saveAll();
    render();
  });

  $(document).on('click', '#forum_panel .unblock-btn', function (e) {
    e.stopPropagation();
    const t = findThread($(this).attr('data-id'));
    if (!t) return;
    t.unblocked = true;
    saveAll();
    render();
  });

  /* ---------- 装路人 ---------- */
  $(document).on('click', '#forum_panel .mole-btn', function (e) {
    e.stopPropagation();
    const t = findThread($(this).attr('data-id'));
    if (!t || !t.mole) return;
    t.mole.revealed = true;
    saveAll();
    render();
  });

  /* ---------- 带节奏 ---------- */
  $(document).on('click', '#forum_panel .stir-btn', function (e) {
    e.stopPropagation();
    const id = String($(this).attr('data-id'));
    stirOpenId = stirOpenId === id ? null : id;
    stirDraft = '';
    render();
    if (stirOpenId) setTimeout(() => $('#forum_panel .stir-input').trigger('focus'), 60);
  });
  $(document).on('input', '#forum_panel .stir-input', function () { stirDraft = this.value; });
  $(document).on('click', '#forum_panel .stir-cancel', function (e) {
    e.stopPropagation();
    stirOpenId = null; stirDraft = ''; render();
  });
  $(document).on('click', '#forum_panel .stir-send', function (e) {
    e.stopPropagation();
    const text = str(stirDraft);
    if (!text) { notify('warning', '写点什么再发'); return; }
    actStir($(this).attr('data-id'), text);
  });
  $(document).on('keydown', '#forum_panel .stir-input', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#forum_panel .stir-send').trigger('click'); }
  });

  /* ---------- 转发给角色 ---------- */
  $(document).on('click', '#forum_panel .fwd-btn', function (e) {
    e.stopPropagation();
    openFwdPicker($(this).attr('data-id'));
  });
  $(document).on('click', '#char_pick_close', () => { $('#forum_char_pick').hide(); pendingFwd = null; });
  $(document).on('click', '#forum_char_pick', function (e) {
    if (e.target === this) { $(this).hide(); pendingFwd = null; }
  });
  $(document).on('click', '#forum_panel .char-pick-row', function () {
    const key = $(this).attr('data-key');
    const id = pendingFwd;
    $('#forum_char_pick').hide();
    pendingFwd = null;
    if (id) forwardThread(id, key);
  });

  /* ---------- 消息面板 ---------- */
  $(document).on('click', '#forum_open_msg', () => {
    $('#forum_main_view').hide();
    $('#forum_msg_panel').css('display', 'flex');
    switchMsgTab(msgTab);
  });
  $(document).on('click', '#forum_msg_back', () => {
    $('#forum_msg_panel').hide();
    $('#forum_main_view').css('display', 'flex');
    render();
  });
  $(document).on('click', '#forum_panel .msg-tab', function () { switchMsgTab($(this).attr('data-tab')); });

  /* ---------- 角色私聊 ---------- */
  $(document).on('click', '#forum_panel .char-row', function () { openChar($(this).attr('data-key')); });
  $(document).on('click', '#char_back_list', () => showCharList());
  $(document).on('click', '#char_wipe', () => {
    if (!activeChar || anyBusy()) return;
    if (!confirm('清空和这个角色的对话？')) return;
    const data = getData();
    if (data.chats[activeChar]) data.chats[activeChar].messages = [];
    saveAll();
    renderCharChat();
    renderCharList();
  });
  $(document).on('click', '#char_send', function () {
    if (anyBusy()) { notify('info', '上一个还在跑'); return; }     // 先拦，别把输入框清空了才发现发不出去
    if (!activeChar || !findCharByKey(activeChar)) { notify('warning', '找不到这个角色'); return; }
    const $input = $('#char_input');
    const text = str($input.val());
    if (!text) return;
    $input.val('');
    sendToChar(activeChar, { type: 'text', text });
  });
  $(document).on('keydown', '#char_input', e => { if (e.key === 'Enter') { e.preventDefault(); $('#char_send').trigger('click'); } });
  $(document).on('click', '#forum_panel .retake-btn', () => retakeChar());

  /* ---------- 陌生网友私信 ---------- */
  $(document).on('click', '#forum_fetch_dm', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
    if (anyBusy()) { notify('info', '上一个还在跑'); return; }   // 先拦，别让按钮白禁用一轮
    $btn.prop('disabled', true).text('正在看…');
    renderDMList();
    try {
      await actFetchDM();
    } finally {
      $btn.prop('disabled', false).text('看看有没有人找我');
      renderDMList();
      renderBadge();
    }
  });

  $(document).on('click', '#forum_panel .dm-item', function (e) {
    if ($(e.target).hasClass('dm-del')) return;
    openDM($(this).attr('data-id'));
  });
  $(document).on('click', '#forum_panel .dm-del', function (e) {
    e.stopPropagation();
    const id = String($(this).attr('data-id'));
    const data = getData();
    data.dms = data.dms.filter(d => String(d.id) !== id);
    saveAll();
    renderDMList();
    renderBadge();
  });
  $(document).on('click', '#dm_back_list', () => showDMList());

  $(document).on('click', '#dm_send', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
    if (anyBusy()) { notify('info', '上一个还在跑'); return; }
    const $input = $('#dm_input');
    const text = str($input.val());
    if (!text) return;
    const dmId = activeDM;
    const dm = getData().dms.find(d => String(d.id) === String(dmId));
    if (!dm) return;

    const token = chatToken();
    dm.messages.push({ who: 'me', text, at: Date.now() });
    $input.val('');
    saveAll();
    renderDMChat(true);

    imBusy = true;
    $btn.prop('disabled', true).text('…');
    try {
      const reply = await continueDM(dm, text);
      if (chatToken() !== token) { notify('warning', '聊天已经切换，这条回复没有保存'); return; }
      const fresh = getData().dms.find(d => String(d.id) === String(dmId));
      if (fresh) { fresh.messages.push({ who: 'them', text: reply, at: Date.now() }); saveAll(); }
    } catch (e) {
      notify('error', '对方没回：' + (e?.message || e));
    } finally {
      imBusy = false;
      $btn.prop('disabled', false).text('发送');
      renderDMChat();
    }
  });
  $(document).on('keydown', '#dm_input', e => { if (e.key === 'Enter') { e.preventDefault(); $('#dm_send').trigger('click'); } });

  /* ---------- 漂流瓶 ---------- */
  $(document).on('click', '#forum_dredge_btn', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
    if (anyBusy()) { notify('info', '上一个还在跑'); return; }
    imBusy = true;
    $btn.prop('disabled', true).text('正在打捞…');
    $('#bottle_message_box').hide();
    try {
      const res = await generateBottle('dredge');
      $('#bottle_author').text(`—— ${res.author}`);
      $('#bottle_text').text(res.text);
      $('#bottle_message_box').fadeIn(300);
    } catch (e) {
      notify('error', '打捞失败：' + (e?.message || e));
    } finally {
      imBusy = false;
      $btn.prop('disabled', false).text('🌊 捞一个瓶子');
    }
  });

  $(document).on('click', '#forum_throw_btn', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
    if (anyBusy()) { notify('info', '上一个还在跑'); return; }
    const $input = $('#forum_bottle_input');
    const text = str($input.val());
    if (!text) { notify('warning', '写点什么再扔吧'); return; }

    imBusy = true;
    $input.prop('disabled', true);
    $btn.prop('disabled', true).text('漂浮中…');
    $('#bottle_message_box').hide();
    try {
      const res = await generateBottle('throw', text);
      $('#bottle_author').text(`—— 来自网友：${res.author}`);
      $('#bottle_text').text(`你扔出的纸条：\n“${text}”\n\n捞到的人回复了你：\n“${res.text}”`);
      $('#bottle_message_box').fadeIn(300);
      $input.val('');
    } catch (e) {
      notify('error', '扔瓶子失败：' + (e?.message || e));
    } finally {
      imBusy = false;
      $input.prop('disabled', false);
      $btn.prop('disabled', false).text('扔出');
    }
  });
  $(document).on('keydown', '#forum_bottle_input', e => { if (e.key === 'Enter') { e.preventDefault(); $('#forum_throw_btn').trigger('click'); } });

  /* ---------- 设置 ---------- */
  $(document).on('click', '#forum_open_api', () => {
    try {
      const cfg = getConfig();
      const sc = scaleOf(cfg);
      syncDistanceUI(distanceOf(cfg));
      $('#forum_gen_count').val(sc.threads);
      $('#forum_post_count').val(sc.posts);
      $('#forum_reply_count').val(sc.replies);
      $('#forum_stir_count').val(sc.stir);
      $('#forum_custom_prompt').val(cfg.customPrompt || '');
      $('#forum_alias').val(cfg.alias || '');
      $('#forum_alias').attr('placeholder', `留空则用「${myAlias()}」`);
      $('#forum_read_chat').prop('checked', !!cfg.readChat);
      $('#forum_read_persona').prop('checked', !!cfg.readPersona);
      $('#forum_read_world').prop('checked', !!cfg.readWorld);
      $('#forum_char_use_st').prop('checked', !!cfg.charUseST);
      $('#forum_api_url').val(cfg.url || '');
      $('#forum_api_key').val(cfg.key || '');
      $('#forum_api_model').val(cfg.model || '');
      $('#forum_model_select').hide();
    } catch (e) { /* 忽略 */ } finally {
      $('#forum_modal_overlay').css('display', 'flex');
    }
  });

  $(document).on('click', '#forum_distance .seg-item', function () {
    syncDistanceUI(String($(this).attr('data-v')));
  });

  $(document).on('click', '#forum_cancel_api, #forum_close_modal_icon', () => $('#forum_modal_overlay').hide());
  $(document).on('click', '#forum_modal_overlay', function (e) { if (e.target === this) $(this).hide(); });

  $(document).on('click', '#forum_clear_all', () => {
    if (anyBusy()) { notify('info', '上一个还在跑，等它结束再清'); return; }
    if (!confirm('清空当前聊天的所有帖子、事件、私信和角色对话？不可撤销。')) return;
    const data = getData();
    data.threads = []; data.hidden = []; data.events = []; data.dms = []; data.chats = {};
    currentTag = null; currentEvent = null; stirOpenId = null; stirDraft = '';
    lastError = null; activeChar = null; activeDM = null;
    saveAll();
    render();
    $('#forum_modal_overlay').hide();
  });

  $(document).on('click', '#forum_fetch_models', async function () {
    const url = str($('#forum_api_url').val());
    const key = str($('#forum_api_key').val());
    if (!url || !key) { notify('warning', '请先填写 API 地址和密钥'); return; }

    const $btn = $(this);
    $btn.text('获取中…').prop('disabled', true);
    try {
      const res = await fetch(url.replace(/\/+$/, '') + '/models', { headers: { 'Authorization': `Bearer ${key}` } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const models = (data?.data || []).map(m => m.id).filter(Boolean).sort();
      if (!models.length) throw new Error('接口没有返回模型列表');

      const $select = $('#forum_model_select');
      $select.empty().append('<option value="">-- 请选择模型 --</option>');
      models.forEach(m => $select.append($('<option>').val(m).text(m)));
      $select.show().off('change').on('change', function () { if (this.value) $('#forum_api_model').val(this.value); });
    } catch (e) {
      notify('error', '获取模型失败：' + (e?.message || e));
    } finally {
      $btn.text('拉取').prop('disabled', false);
    }
  });

  $(document).on('click', '#forum_save_api', () => {
    const level = parseInt($('#forum_distance .seg-item.active').attr('data-v'), 10) || 0;
    const alias = str($('#forum_alias').val());
    saveConfig({
      distance: level,
      customPrompt: str($('#forum_custom_prompt').val()),
      alias,
      readChat: level >= 1 ? true : $('#forum_read_chat').is(':checked'),
      readPersona: $('#forum_read_persona').is(':checked'),
      readWorld: $('#forum_read_world').is(':checked'),
      charUseST: $('#forum_char_use_st').is(':checked'),
      genCount: clampInt($('#forum_gen_count').val(), 1, 5, 2),
      postCount: clampInt($('#forum_post_count').val(), 1, 12, 3),
      replyCount: clampInt($('#forum_reply_count').val(), 0, 6, 2),
      stirCount: clampInt($('#forum_stir_count').val(), 1, 8, 3),
      url: str($('#forum_api_url').val()),
      key: str($('#forum_api_key').val()),
      model: str($('#forum_api_model').val()),
    });
    if (!alias && !sessionAlias) sessionAlias = autoAlias();
    $('#forum_modal_overlay').hide();
    notify('success', `配置已保存 · 距离：${['无关', '擦边', '直击'][level]}`);
  });
}

function bindChatChange() {
  try {
    const ctx = getContext();
    const es = ctx.eventSource || script.eventSource;
    const types = ctx.eventTypes || ctx.event_types || script.event_types;
    if (!es || !types?.CHAT_CHANGED) return;
    es.on(types.CHAT_CHANGED, () => {
      currentTag = null; currentEvent = null; currentFilter = 'all';
      stirOpenId = null; stirDraft = ''; activeDM = null; activeChar = null; lastError = null;
      if ($('#forum_panel').is(':visible')) { showDMList(); showCharList(); render(); }
    });
  } catch (e) { /* 忽略 */ }
}

/* ============================== 启动 ============================== */

jQuery(async () => {
  try {
    const html = await renderExtensionTemplateAsync('third-party/forum-plugin', 'template');
    $('body').append(html);

    if (!$('#forum_menu_btn').length) {
      $('#extensionsMenu').append(`
        <div id="forum_menu_btn" class="list-group-item flex-container flexGap5">
          <div class="fa-solid fa-comments extensionsMenuExtensionButton"></div>
          <span>幻境社区</span>
        </div>`);
    }

    sessionAlias = autoAlias();

    bindEvents();
    bindChatChange();
  } catch (e) {
    console.error('[幻境社区] 加载失败', e);
  }
});