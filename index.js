import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import * as script from '../../../../script.js';

const MODULE = 'forum_plugin';
const POS_KEY = 'forum_plugin_pos';
const PLATFORMS = ['forum', 'tieba', 'weibo', 'xhs'];
const PLATFORM_NAMES = { forum: '论坛', tieba: '贴吧', weibo: '微博', xhs: '小红书' };
const STAGE_NAMES = ['初现', '回应', '爆料', '退潮'];
const EDGE = 8;

const defaultConfig = {
  customPrompt: '', readChat: false, readPersona: false, readWorld: false,
  genCount: 2, distance: 0, alias: '',
};

let currentFilter = 'all';
let currentTag = null;
let currentEvent = null;      // 只看某个事件
let stirOpenId = null;        // 哪张卡展开了带节奏输入框
let stirDraft = '';
let busy = false;
let busyLabel = '';           // 加载卡上显示的文案
let lastError = null;
let activeDM = null;
let msgTab = 'dm';
let uidSeq = 0;
let sessionAlias = '';        // 配置里留空时，本次会话固定用这个小号名
const detachedStore = { threads: [], hidden: [], events: [], dms: [] };

/* ============================== 工具 ============================== */

function makeId(p = 't') {
  uidSeq += 1;
  return `${p}_${Date.now().toString(36)}_${uidSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
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

// 配置里填了就用填的；留空时本次会话固定用同一个随机名，
// 不然同一轮里署名和网友喊的名字会不一致
function myAlias() {
  const set = str(getConfig().alias);
  if (set) return set;
  if (!sessionAlias) sessionAlias = autoAlias();
  return sessionAlias;
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
  const n = parseInt(config.distance, 10);
  return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 0;
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

function recentChat(ctx, n) {
  if (!Array.isArray(ctx.chat) || !ctx.chat.length) return '';
  return ctx.chat.slice(-n)
    .map(m => `${m.name}: ${String(m.mes || '').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
}

async function storyBlock(ctx, config) {
  const level = distanceOf(config);
  let s = '';

  if (config.customPrompt) s += `\n【世界观设定】\n${config.customPrompt}\n`;

  // 擦边/直击必须有素材，否则没东西可以传错，所以强制读聊天
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
    try {
      if (typeof script.getWorldInfoPrompt === 'function') {
        const wi = await script.getWorldInfoPrompt(ctx.chat, 3000, true);
        if (wi?.worldInfoString) s += `\n【世界书背景】\n${wi.worldInfoString}\n`;
      }
    } catch (e) { /* 读不到就算了 */ }
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

async function callAPI(prompt, maxTokens = 800) {
  const config = getConfig();

  if (config.url && config.key && config.model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(config.url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0.95 }),
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
  throw new Error('模型没有输出合法 JSON。原文开头：' + cleaned.slice(0, 160));
}

/* ============================== 清洗 ============================== */

function sanitizePosts(arr, limit = 8) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, limit).map(p => ({
    author: str(p?.author) || '匿名网友',
    content: str(p?.content),
    suspicious: !!p?.suspicious,
    replies: Array.isArray(p?.replies)
      ? p.replies.slice(0, 5).map(r => ({ author: str(r?.author) || '匿名网友', content: str(r?.content) })).filter(r => r.content)
      : [],
  })).filter(p => p.content);
}

function sanitizeThread(raw, extra = {}) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    id: makeId(),
    type: PLATFORMS.includes(t.type) ? t.type : (extra.type || 'forum'),
    title: str(t.title).slice(0, 140),
    author: str(t.author) || '匿名网友',
    content: str(t.content),
    tags: Array.isArray(t.tags) ? t.tags.map(str).filter(Boolean).slice(0, 5) : [],
    posts: sanitizePosts(t.posts),
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

/* ============================== 生成器 ============================== */

async function generateThreads(forceType = null) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const count = Math.min(5, Math.max(1, parseInt(config.genCount, 10) || 2));
  const story = await storyBlock(ctx, config);

  const typeRule = forceType
    ? `所有帖子的 "type" 都必须是 "${forceType}"（${PLATFORM_NAMES[forceType]}）。`
    : `"type" 必须在 forum / tieba / weibo / xhs 之间混合。`;

  const prompt = `你是一个独立运行的"赛博网络社区服务器"。你的唯一任务是模拟随机网友发帖。
请生成 ${count} 条互不相关的帖子。${typeRule}
${story}
${distanceBlock(level)}

${PLATFORM_BLOCK}

${MOLE_RULE}
${recentTitles()}${knownHandles()}
【其他要求】
- 每条帖子必须有 2-4 条网友回复，其中至少一条带楼中楼。
- 每条帖子 2-3 个 tags。
- 部分帖子带 vote，不需要就填 null。

只输出 JSON 数组，每个元素形如：
${THREAD_SCHEMA}`;

  const parsed = extractJson(await callAPI(prompt, 2000), 'array');
  const list = (Array.isArray(parsed) ? parsed : [parsed]).map(x => sanitizeThread(x, forceType ? { type: forceType } : {})).filter(Boolean);
  if (!list.length) throw new Error('模型输出里没有可用的帖子');
  return list;
}

async function generateEvent() {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
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

  const parsed = extractJson(await callAPI(prompt, 2600), 'object');
  const ev = {
    id: makeId('e'),
    title: str(parsed?.event?.title) || '无名事件',
    summary: str(parsed?.event?.summary),
    stage: 0,
    createdAt: Date.now(),
  };

  const want = ['weibo', 'tieba', 'xhs', 'forum'];
  const threads = (Array.isArray(parsed?.threads) ? parsed.threads : [])
    .map((x, i) => sanitizeThread(x, { type: PLATFORMS.includes(x?.type) ? x.type : want[i] || 'forum', eventId: ev.id, eventTitle: ev.title, stage: 0 }))
    .filter(Boolean);

  if (!threads.length) throw new Error('事件生成失败：没有拿到帖子');
  return { event: ev, threads };
}

async function fermentEvent(eventId) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
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
${MOLE_RULE}
${knownHandles()}
新帖必须**明确提到**之前那几波的内容（引用、反驳、或者嘲讽当初猜错的人）。

只输出 JSON 数组，含 1 到 2 条帖子，每个元素形如：
${THREAD_SCHEMA}
可以额外带 "blocked": true。`;

  const parsed = extractJson(await callAPI(prompt, 1800), 'array');
  const threads = (Array.isArray(parsed) ? parsed : [parsed])
    .map(x => sanitizeThread(x, { eventId: ev.id, eventTitle: ev.title, stage: nextStage }))
    .filter(Boolean);

  if (!threads.length) throw new Error('发酵失败：没有拿到新帖');
  return { threads, nextStage };
}

async function generateStir(thread, userText, alias) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
  const story = await storyBlock(ctx, config);

  const existing = (thread.posts || []).map((p, i) => `${i + 1}. ${p.author}${p.isUser ? '（就是我的小号）' : ''}：${p.content}`).join('\n');

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
1. 生成 2 到 4 条新回复，必须直接针对"${alias}"刚说的那句话。
2. 反应要有分歧：有人信，有人嘲，有人嫌他造谣，有人顺着往更离谱的方向推。
3. ${level >= 1
    ? `如果"${alias}"说的东西太准、太像亲历者才知道的，就让其中一条回复起疑（"等一下，你怎么知道有车？"），并把那条的 "suspicious" 设为 true。至多一条。`
    : `不需要有人起疑，"suspicious" 全部填 false。`}
4. 禁止扮演故事里的角色，回复人全部是你捏造的路人网名。

只输出 JSON：
{ "posts": [ { "author": "网名", "content": "回复", "suspicious": false, "replies": [{ "author": "网名", "content": "楼中楼" }] } ] }`;

  const parsed = extractJson(await callAPI(prompt, 900), 'object');
  const posts = sanitizePosts(parsed?.posts, 4);
  if (!posts.length) throw new Error('没人理你（模型没给出回复）');
  return posts;
}

async function generateNecro(keyword) {
  const ctx = getContext();
  const config = getConfig();
  const level = distanceOf(config);
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
5. type 只能是 "forum" 或 "tieba"。

只输出一个 JSON 对象：
${THREAD_SCHEMA}
额外必须包含：
  "year": "${year}",
  "lastLogin": "楼主最后一次登录的日期，格式 ${year}-MM-DD",
  "deadEnd": "一句话说明这帖子为什么断在这里"`;

  const parsed = extractJson(await callAPI(prompt, 1400), 'object');
  const t = sanitizeThread(Array.isArray(parsed) ? parsed[0] : parsed, {
    type: (parsed?.type === 'tieba') ? 'tieba' : 'forum',
    createdAt: Date.now() - yearsAgo * 365 * 24 * 3600 * 1000,
    isNecro: true,
  });
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

  const log = dm.messages.slice(-10)
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

【对话记录】
${log}
${alias}：${userText}

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

/* ============================== 私信渲染 ============================== */

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

async function run(label, fn) {
  if (busy) { notify('info', '上一个还在跑'); return; }
  setBusy(true, label);
  lastError = null;
  render();
  try {
    await fn();
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
  return run('刷新', async () => {
    const data = getData();
    const forceType = PLATFORMS.includes(currentFilter) ? currentFilter : null;
    const threads = await generateThreads(forceType);
    data.threads.push(...threads);
    currentTag = null;
    currentEvent = null;
    saveAll();
    notify('success', `新增 ${threads.length} 条帖子`);
    $('#forum_list').scrollTop(0);
  });
}

function actEvent() {
  return run('造事件', async () => {
    const data = getData();
    const { event, threads } = await generateEvent();
    data.events.push(event);
    data.threads.push(...threads);
    currentTag = null;
    currentFilter = 'all';
    currentEvent = event.id;
    saveAll();
    notify('success', `「${event.title}」· ${threads.length} 个平台`);
    $('#forum_list').scrollTop(0);
  });
}

function actFerment(eventId) {
  return run('发酵', async () => {
    const data = getData();
    const { threads, nextStage } = await fermentEvent(eventId);
    data.threads.push(...threads);
    const ev = findEvent(eventId);
    if (ev) ev.stage = nextStage;
    currentEvent = eventId;
    currentTag = null;
    saveAll();
    notify('success', `第${nextStage + 1}波：${STAGE_NAMES[nextStage]}`);
    $('#forum_list').scrollTop(0);
  });
}

function actNecro(keyword) {
  return run('挖坟', async () => {
    const data = getData();
    const t = await generateNecro(keyword);
    data.threads.push(t);
    currentTag = null;
    currentEvent = null;
    currentFilter = 'all';
    saveAll();
    notify('success', '翻出来一个老帖');
    $('#forum_list').scrollTop(0);
  });
}

// 先请求，拿到网友反应后再把你的发言和回复一起写进帖子。
// 失败时帖子不动，输入框保留原文，重发不会出现两句一样的话。
function actStir(threadId, text) {
  return run('带节奏', async () => {
    const t = findThread(threadId);
    if (!t) throw new Error('帖子不见了');

    const alias = myAlias();
    const preview = { ...t, posts: [...(t.posts || []), { author: alias, content: text, isUser: true, replies: [] }] };
    const posts = await generateStir(preview, text, alias);

    const fresh = findThread(threadId);
    if (!fresh) throw new Error('帖子不见了');
    fresh.posts = fresh.posts || [];
    fresh.posts.push({ author: alias, content: text, isUser: true, replies: [] });
    fresh.posts.push(...posts);
    fresh.likes = Math.max(0, (Number(fresh.likes) || 0) + Math.floor(Math.random() * 40));

    stirOpenId = null;
    stirDraft = '';
    saveAll();

    const level = distanceOf(getConfig());
    const suspected = posts.some(p => p.suspicious);
    if (level >= 1 && (suspected || Math.random() < 0.3)) {
      try {
        const dm = await generateDM(fresh);
        getData().dms.push(dm);
        saveAll();
        notify('info', `${dm.author} 私信了你`);
      } catch (e) { /* 没人找就算了 */ }
    }
  });
}

function actFetchDM() {
  return run('捞私信', async () => {
    const data = getData();
    const pool = data.threads.filter(t => (t.posts || []).some(p => p.isUser));
    const thread = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    const dm = await generateDM(thread);
    data.dms.push(dm);
    saveAll();
    notify('success', `${dm.author} 找你`);
  });
}

/* ============================== 拖动 ============================== */

function clampPos(left, top) {
  const panel = document.getElementById('forum_panel');
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

function applySavedPos() {
  const panel = document.getElementById('forum_panel');
  if (!panel) return;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
  if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
  const c = clampPos(pos.left, pos.top);
  panel.style.left = `${c.left}px`;
  panel.style.top = `${c.top}px`;
}

function resetPos() {
  const panel = document.getElementById('forum_panel');
  if (!panel) return;
  panel.style.left = '';
  panel.style.top = '';
  try { localStorage.removeItem(POS_KEY); } catch (e) { /* 忽略 */ }
  notify('info', '窗口位置已复位');
}

const NO_DRAG = '.hd-btn, .hd-primary, .app-close, .app-filters, .app-trends, .trend-item, .filter-pill, button, input, textarea, select, a, [contenteditable]';

function bindDrag() {
  const panel = document.getElementById('forum_panel');
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

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!panel.style.left || panel.style.display === 'none') return;
      if (panel.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const c = clampPos(parseFloat(panel.style.left), parseFloat(panel.style.top));
      panel.style.left = `${c.left}px`;
      panel.style.top = `${c.top}px`;
      savePos(c.left, c.top);
    }, 150);
  });
}

/* ============================== 事件绑定 ============================== */

function openPanel() {
  $('#forum_panel').css('display', 'flex');
  $('#forum_msg_panel, #forum_modal_overlay, #forum_gen_sheet').hide();
  $('#forum_main_view').css('display', 'flex');
  applySavedPos();
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

function switchMsgTab(tab) {
  msgTab = tab === 'bottle' ? 'bottle' : 'dm';
  $('#forum_panel .msg-tab').removeClass('active');
  $(`#forum_panel .msg-tab[data-tab="${msgTab}"]`).addClass('active');
  $('#msg_tab_dm').css('display', msgTab === 'dm' ? 'flex' : 'none');
  $('#msg_tab_bottle').css('display', msgTab === 'bottle' ? 'flex' : 'none');
  if (msgTab === 'dm' && !activeDM) showDMList();
}

function bindEvents() {
  bindDrag();

  /* ---------- 面板开关 ---------- */
  $(document).on('click', '#forum_menu_btn', () => {
    const $p = $('#forum_panel');
    if ($p.is(':visible')) $p.hide(); else openPanel();
  });
  $(document).on('click', '#forum_close_btn', () => $('#forum_panel').hide());
  $(document).on('dblclick', '#forum_drag_handle .mast-left', resetPos);
  $(document).on('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#forum_panel').is(':visible')) return;
    if ($('#forum_modal_overlay').is(':visible')) { $('#forum_modal_overlay').hide(); return; }
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

  /* ---------- 卡片操作（点赞/收藏就地更新，不重排列表） ---------- */
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

  $(document).on('click', '#forum_fetch_dm', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
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
    const $input = $('#dm_input');
    const text = str($input.val());
    if (!text) return;
    const dm = getData().dms.find(d => String(d.id) === String(activeDM));
    if (!dm) return;

    dm.messages.push({ who: 'me', text, at: Date.now() });
    $input.val('');
    saveAll();
    renderDMChat(true);

    $btn.prop('disabled', true).text('…');
    try {
      const reply = await continueDM(dm, text);
      dm.messages.push({ who: 'them', text: reply, at: Date.now() });
      saveAll();
    } catch (e) {
      notify('error', '对方没回：' + (e?.message || e));
    } finally {
      $btn.prop('disabled', false).text('发送');
      renderDMChat();
    }
  });
  $(document).on('keydown', '#dm_input', e => { if (e.key === 'Enter') { e.preventDefault(); $('#dm_send').trigger('click'); } });

  /* ---------- 漂流瓶 ---------- */
  $(document).on('click', '#forum_dredge_btn', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
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
      $btn.prop('disabled', false).text('🌊 捞一个瓶子');
    }
  });

  $(document).on('click', '#forum_throw_btn', async function () {
    const $btn = $(this);
    if ($btn.prop('disabled')) return;
    const $input = $('#forum_bottle_input');
    const text = str($input.val());
    if (!text) { notify('warning', '写点什么再扔吧'); return; }

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
      $input.prop('disabled', false);
      $btn.prop('disabled', false).text('扔出');
    }
  });
  $(document).on('keydown', '#forum_bottle_input', e => { if (e.key === 'Enter') { e.preventDefault(); $('#forum_throw_btn').trigger('click'); } });

  /* ---------- 设置 ---------- */
  $(document).on('click', '#forum_open_api', () => {
    try {
      const cfg = getConfig();
      syncDistanceUI(distanceOf(cfg));
      $('#forum_custom_prompt').val(cfg.customPrompt || '');
      $('#forum_alias').val(cfg.alias || '');
      $('#forum_alias').attr('placeholder', `留空则用「${myAlias()}」`);
      $('#forum_read_chat').prop('checked', !!cfg.readChat);
      $('#forum_read_persona').prop('checked', !!cfg.readPersona);
      $('#forum_read_world').prop('checked', !!cfg.readWorld);
      $('#forum_gen_count').val(cfg.genCount || 2);
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
    if (!confirm('清空当前聊天的所有帖子、事件和私信？不可撤销。')) return;
    const data = getData();
    data.threads = []; data.hidden = []; data.events = []; data.dms = [];
    currentTag = null; currentEvent = null; stirOpenId = null; lastError = null;
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
      genCount: Math.min(5, Math.max(1, parseInt($('#forum_gen_count').val(), 10) || 2)),
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
      stirOpenId = null; stirDraft = ''; activeDM = null; lastError = null;
      if ($('#forum_panel').is(':visible')) { showDMList(); render(); }
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

    sessionAlias = autoAlias();   // 配置里留空时用它，整个会话保持一致

    bindEvents();
    bindChatChange();
  } catch (e) {
    console.error('[幻境社区] 加载失败', e);
  }
});