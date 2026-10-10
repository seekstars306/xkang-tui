/* 小康客服助手 Web UI 交互
 * - 会话：新建、按日期分组的历史列表、回放、删除；地址栏 #会话ID 刷新后可恢复
 * - 提问：文字、截图（Ctrl+V / 拖拽 / 选择文件）、文本日志附件
 * - 排查过程：把工具调用翻译成客服看得懂的步骤，点开可看原始参数和返回结果
 * - 回答：按【结论】【依据】【客服话术】【还需确认】排版，结论盖"已确认 / 推断 / 无法确定"印章；话术、单号一键复制
 * 纯文本处理（分段、印章识别、步骤说明、Markdown）在 answer.js
 */
'use strict';

const X = window.XkAnswer;

const state = {
  mode: 'business',
  sessionId: null,
  sessions: [],
  busy: false,
  attachments: [], // Array<{ id, name, type, size, dataUrl, isImage, textContent }>
  health: 'checking',
  follow: true,
};

const $ = (id) => document.getElementById(id);

const els = {
  main: $('main'),
  scrim: $('scrim'),
  sessionList: $('sessionList'),
  newSessionBtn: $('newSessionBtn'),
  userAvatar: $('userAvatar'),
  userName: $('userName'),
  helpBtn: $('helpBtn'),
  versionBtn: $('versionBtn'),
  updateBanner: $('updateBanner'),
  updateBannerText: $('updateBannerText'),
  doUpdateBtn: $('doUpdateBtn'),
  dismissUpdateBtn: $('dismissUpdateBtn'),
  menuBtn: $('menuBtn'),
  sessionTitle: $('sessionTitle'),
  conn: $('conn'),
  connText: $('connText'),
  scroller: $('scroller'),
  welcome: $('welcome'),
  log: $('log'),
  composer: $('composer'),
  attachments: $('attachments'),
  input: $('input'),
  fileInput: $('fileInput'),
  attachBtn: $('attachBtn'),
  sendBtn: $('sendBtn'),
  feedbackModal: $('feedbackModal'),
  feedbackText: $('feedbackText'),
  feedbackContextTip: $('feedbackContextTip'),
  feedbackSubmit: $('feedbackSubmit'),
  helpModal: $('helpModal'),
  checkUpdateBtn: $('checkUpdateBtn'),
  imageModal: $('imageModal'),
  imageModalImg: $('imageModalImg'),
  toast: $('toast'),
};

const DEFAULT_PLACEHOLDER = '输入单号、报错文案或问题，Ctrl+V 可粘贴截图';

// ---------------------------------------------------------------------------
// DOM 小工具
// ---------------------------------------------------------------------------
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of [].concat(children == null ? [] : children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function legacyCopy(text) {
  const ta = el('textarea', { readonly: true, style: 'position:fixed;left:-9999px;top:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

async function copyText(text, doneMsg, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else legacyCopy(text);
  } catch {
    try {
      legacyCopy(text);
    } catch {
      toast('复制失败，请手动选中文字复制');
      return;
    }
  }
  toast(doneMsg || '已复制');
  if (button) {
    button.classList.add('is-done');
    setTimeout(() => button.classList.remove('is-done'), 1500);
  }
}

// 长串数字单号：每 4 位留出间隔便于核对，复制时仍是连续数字
const ID_RE = /(?<![\w.])(\d{13,20})(?![\w.])/g;
const ID_TEST = /\d{13,20}/;

function idChip(id, interactive) {
  const chip = el('span', interactive ? { class: 'oid', role: 'button', tabindex: '0', title: '点击复制', 'data-id': id } : { class: 'oid is-static' });
  for (let i = 0; i < id.length; i += 4) chip.append(el('span', { text: id.slice(i, i + 4) }));
  return chip;
}

function decorateIds(rootEl) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!ID_TEST.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest('pre, a, .oid, .code, textarea, input')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const s = node.nodeValue;
    const interactive = !node.parentElement.closest('button');
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of s.matchAll(ID_RE)) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      frag.append(idChip(m[1], interactive));
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    if (last < s.length) frag.append(s.slice(last));
    node.replaceWith(frag);
  }
}

function mdBlock(text, cls) {
  const div = el('div', { class: cls ? `md ${cls}` : 'md', html: X.renderMarkdown(text) });
  return div;
}

// ---------------------------------------------------------------------------
// 连接状态（每 6 秒探测本地服务与公司服务）
// ---------------------------------------------------------------------------
const HEALTH = {
  checking: { text: '正在连接…', tip: '正在连接本地服务' },
  ready: { text: '已连接', tip: '可以查询订单、日志和代码' },
  warning: { text: '公司服务未连接', tip: '连不上公司服务：查不了订单、日志和代码，提问也可能失败。会自动重连。' },
  offline: { text: '本地服务已停止', tip: '请重新打开 xhang，再刷新本页' },
};

function setHealth(status) {
  state.health = status;
  const h = HEALTH[status] || HEALTH.checking;
  els.conn.dataset.state = status;
  els.connText.textContent = h.text;
  els.conn.title = h.tip;
  if (status === 'offline') els.input.placeholder = '本地服务已停止，请重新打开 xhang 后刷新本页';
  else if (status === 'warning') els.input.placeholder = '公司服务暂时连不上，提问可能失败；连上后右上角会显示“已连接”';
  else els.input.placeholder = DEFAULT_PLACEHOLDER;
  updateSendState();
}

async function pollHealth() {
  try {
    const resp = await fetch('/api/bootstrap', { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      setHealth('offline');
      return;
    }
    const info = await resp.json();
    state.mode = info.mode || 'business';
    setHealth(info.mcpConnected === false ? 'warning' : 'ready');
  } catch {
    setHealth('offline');
  }
}

async function bootstrap() {
  try {
    const resp = await fetch('/api/bootstrap');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const info = await resp.json();
    const rawName = info.userName || '客服专员';
    els.userName.textContent = rawName;
    // "技术-张朝" 取 "张"，"客服-贾宇晨" 取 "贾"
    const clean = rawName.replace(/^(技术|客服|运营|测试|二线客服)[-_/:：]*/, '').trim();
    els.userAvatar.textContent = (clean || rawName).charAt(0) || '客';
    setHealth(info.mcpConnected === false ? 'warning' : 'ready');
  } catch {
    setHealth('offline');
  }
  await loadSessions();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && state.sessions.some((s) => s.id === fromHash)) await selectSession(fromHash);
  checkUpdate(false);
  setInterval(pollHealth, 6000);
}

// ---------------------------------------------------------------------------
// 版本检测与在线更新
// ---------------------------------------------------------------------------
let updateInfo = null;

function showUpdateReady(version) {
  els.updateBannerText.textContent = `新版本 v${version} 已下载好。关闭 xhang 窗口后重新打开即可使用。`;
  els.doUpdateBtn.hidden = true;
  els.updateBanner.hidden = false;
}

async function checkUpdate(manual) {
  try {
    const resp = await fetch('/api/version/check');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const info = await resp.json();
    if (info.currentVersion) {
      els.versionBtn.textContent = `版本 v${info.currentVersion}`;
      els.versionBtn.title = '检查更新';
    }
    const pending = localStorage.getItem('pending_restart_version');
    // 重启后已经是目标版本，清掉"等待重启"标记
    if (pending && info.currentVersion === pending) localStorage.removeItem('pending_restart_version');

    if (info.hasUpdate && info.latestVersion) {
      updateInfo = info;
      if (localStorage.getItem('pending_restart_version') === info.latestVersion) {
        showUpdateReady(info.latestVersion);
      } else {
        const note = Array.isArray(info.releaseNotes) && info.releaseNotes[0] ? `：${info.releaseNotes[0]}` : '';
        els.updateBannerText.textContent = `有新版本 v${info.latestVersion}${note}`;
        els.doUpdateBtn.hidden = false;
        els.doUpdateBtn.disabled = false;
        els.doUpdateBtn.textContent = '立即更新';
        els.updateBanner.hidden = false;
      }
      if (manual) toast(`有新版本 v${info.latestVersion}，点页面顶部的“立即更新”`);
    } else {
      els.updateBanner.hidden = true;
      localStorage.removeItem('pending_restart_version');
      if (manual) toast(`已经是最新版本${info.currentVersion ? ` v${info.currentVersion}` : ''}`);
    }
  } catch (err) {
    if (manual) toast(`检查更新失败：${err.message}`);
  }
}

async function runUpdate() {
  if (!updateInfo) return;
  els.doUpdateBtn.disabled = true;
  els.doUpdateBtn.textContent = '正在下载…';
  try {
    const resp = await fetch('/api/version/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadUrl: updateInfo.downloadUrl }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.success) throw new Error(result.message || result.error || `HTTP ${resp.status}`);
    if (updateInfo.latestVersion) localStorage.setItem('pending_restart_version', updateInfo.latestVersion);
    showUpdateReady(updateInfo.latestVersion);
    toast('新版本已下载，重新打开 xhang 后生效');
  } catch (err) {
    els.doUpdateBtn.disabled = false;
    els.doUpdateBtn.textContent = '重试';
    toast(`更新失败：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 会话列表
// ---------------------------------------------------------------------------
let viewToken = 0; // 切换会话时作废上一次未完成的加载/轮询

function setTitle(title) {
  els.sessionTitle.textContent = title;
  els.sessionTitle.title = title;
}

function setHash(id) {
  const url = id ? `#${encodeURIComponent(id)}` : location.pathname + location.search;
  history.replaceState(null, '', url);
}

function showLog() {
  els.welcome.hidden = true;
  els.log.hidden = false;
}

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function sessionGroups(list) {
  const DAY = 86400000;
  const today = dayStart(new Date());
  const groups = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  for (const s of list) {
    const d = dayStart(new Date(s.lastActiveAt || s.createdAt || 0));
    const idx = d >= today ? 0 : d >= today - DAY ? 1 : d >= today - 6 * DAY ? 2 : 3;
    groups[idx].items.push(s);
  }
  return groups.filter((g) => g.items.length);
}

function shortTime(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  if (dayStart(t) >= dayStart(new Date()) - 86400000) return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return `${t.getMonth() + 1}月${t.getDate()}日`;
}

const MARK_TEXT = { reviewed: '核', needs_human: '待', unreviewed: '未' };
const REVIEW_TEXT = { reviewed: '已复核', needs_human: '需人工核实', unreviewed: '未复核' };

function verdictMark(verdict) {
  if (!verdict || !MARK_TEXT[verdict]) return el('span', { class: 'mark', 'aria-hidden': 'true' });
  return el('span', { class: 'mark', 'data-v': verdict, title: REVIEW_TEXT[verdict] }, MARK_TEXT[verdict]);
}

function sessionRow(s) {
  const li = el('li', { class: 'session-row' });
  const btn = el(
    'button',
    { type: 'button', class: 'session', 'aria-current': s.id === state.sessionId ? 'page' : null, title: s.title },
    [
      verdictMark(s.verdict),
      el('span', { class: 'session-title', text: s.title || '未命名会话' }),
      el('time', { class: 'session-time', datetime: s.lastActiveAt, text: shortTime(s.lastActiveAt) }),
    ]
  );
  btn.addEventListener('click', () => selectSession(s.id));
  const del = el('button', { type: 'button', class: 'session-del', 'aria-label': `删除会话：${s.title}`, title: '删除' }, [icon('trash')]);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    armDelete(del, s.id);
  });
  li.append(btn, del);
  return li;
}

// 删除需要点两次：第一次变成"确认删除"，3 秒内或失去焦点前再点一次才删除
function armDelete(btn, id) {
  if (btn.classList.contains('is-armed')) {
    deleteSession(id);
    return;
  }
  btn.classList.add('is-armed');
  btn.replaceChildren('确认删除');
  const reset = () => {
    clearTimeout(timer);
    btn.classList.remove('is-armed');
    btn.replaceChildren(icon('trash'));
  };
  const timer = setTimeout(reset, 3000);
  btn.addEventListener('blur', reset, { once: true });
}

function renderSessionList() {
  const nav = els.sessionList;
  nav.replaceChildren();
  if (!state.sessions.length) {
    nav.append(el('p', { class: 'session-empty', text: '还没有会话记录。在右侧输入单号或问题，就会开始第一条。' }));
    return;
  }
  for (const g of sessionGroups(state.sessions)) {
    nav.append(el('h2', { class: 'session-group', text: g.label }));
    nav.append(el('ul', { class: 'session-ul' }, g.items.map(sessionRow)));
  }
}

async function loadSessions() {
  try {
    const resp = await fetch('/api/sessions');
    const data = await resp.json();
    // 没有任何对话的空会话（例如发送失败）不占列表位置
    state.sessions = (data.sessions || []).filter((s) => s.messageCount > 0 || s.id === state.sessionId);
  } catch (err) {
    console.error('加载会话列表失败:', err);
  }
  renderSessionList();
  const cur = state.sessions.find((s) => s.id === state.sessionId);
  if (cur && cur.title) setTitle(cur.title);
}

function startNewSession() {
  if (state.busy) {
    toast('当前问题还在排查，完成后再新建会话');
    return;
  }
  viewToken++;
  state.sessionId = null;
  els.log.replaceChildren();
  els.log.hidden = true;
  els.welcome.hidden = false;
  setTitle('新会话');
  setHash('');
  renderSessionList();
  closeSidebar();
  els.input.focus();
}

async function selectSession(id) {
  if (state.busy) {
    toast('当前问题还在排查，完成后再切换会话');
    return;
  }
  const token = ++viewToken;
  try {
    const resp = await fetch(`/api/session/${encodeURIComponent(id)}`);
    if (!resp.ok) {
      toast('这个会话已经不存在了');
      await loadSessions();
      return;
    }
    const data = await resp.json();
    if (token !== viewToken) return;
    state.sessionId = data.id;
    setTitle(data.title || '未命名会话');
    setHash(data.id);
    showLog();
    renderHistory(data.messages || [], { busy: data.busy, pendingQuestion: data.pendingQuestion });
    renderSessionList();
    closeSidebar();
    revealLastTurn();
    if (data.busy) watchRunningSession(data.id, token);
  } catch (err) {
    toast(`打开会话失败：${err.message}`);
  }
}

// 打开的会话在后台还没跑完（例如刷新了页面）：等它完成后重新加载
async function watchRunningSession(id, token) {
  for (let i = 0; i < 400; i++) {
    await sleep(3000);
    if (token !== viewToken || state.sessionId !== id || state.busy) return;
    try {
      const resp = await fetch(`/api/session/${encodeURIComponent(id)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.busy) {
        if (data.pendingQuestion && !document.querySelector('.gate-question')) renderHistory(data.messages || [], { busy: true, pendingQuestion: data.pendingQuestion });
        continue;
      }
      if (token !== viewToken) return;
      renderHistory(data.messages || [], { busy: false });
      revealLastTurn();
      loadSessions();
      return;
    } catch {
      /* 本地服务暂时连不上，继续等 */
    }
  }
}

async function deleteSession(id) {
  try {
    const resp = await fetch(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (state.sessionId === id) startNewSession();
    await loadSessions();
    toast('会话已删除');
  } catch (err) {
    toast(`删除失败：${err.message}`);
  }
}

// harness 自动注入的提醒（含旧版本格式）不是客服的输入，历史记录中不展示
const REMINDER_PREFIXES = ['<system-reminder>', '【系统提醒】', '【通道降级提醒】', '【排查提示】', '【取证盲区提醒】', '请根据前面工具调用的检索结果', '你刚才只是用文字', '[[ESCALATE_TO_L2]]'];

function isReminderMessage(msg) {
  if (msg.isReminder) return true;
  const text = typeof msg.content === 'string' ? msg.content.trimStart() : '';
  return REMINDER_PREFIXES.some((p) => text.startsWith(p));
}

function userContent(content) {
  const images = [];
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') text += part.text;
      else if (part.type === 'image_url' && part.image_url && part.image_url.url) images.push(part.image_url.url);
    }
  }
  return { text, images };
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** 按"提问 → 排查过程 → 回答"重放一个会话 */
function renderHistory(messages, opts) {
  els.log.replaceChildren();
  let ctx = null;
  const close = (isLast) => {
    if (!ctx) return;
    if (isLast && opts && opts.busy) {
      ctx.process.status.hidden = false;
      setStatus(ctx, 'background');
      ctx.process.statusTime.textContent = '';
    } else {
      finalizeTurn(ctx, ctx.answerText, false);
    }
  };
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (isReminderMessage(msg)) continue;
      close(false);
      const { text, images } = userContent(msg.content);
      ctx = createTurn(text, images);
    } else if (!ctx) {
      continue;
    } else if (msg.role === 'assistant') {
      ctx.publicReviewStatus = msg.publicReviewStatus || null;
      if (msg.reasoning_content) {
        thinkAppend(ctx, msg.reasoning_content);
        endThink(ctx);
      }
      const text = X.contentText(msg.content);
      const usable = text.trim() && !X.isPlaceholderReply(text);
      if (msg.tool_calls && msg.tool_calls.length) {
        if (usable) addNoteStep(ctx, text);
        for (const tc of msg.tool_calls) addToolStep(ctx, tc);
      } else if (usable) {
        if (ctx.answerText) addNoteStep(ctx, ctx.answerText);
        ctx.answerText = text;
      }
    } else if (msg.role === 'tool') {
      completeToolStep(ctx, msg.tool_call_id, X.contentText(msg.content), false);
    }
  }
  close(true);
  if (ctx && opts?.pendingQuestion) addQuestionCard(ctx, opts.pendingQuestion);
}
const renderHistoryMessages = renderHistory;

// ---------------------------------------------------------------------------
// 一轮问答：提问 + 排查过程 + 回答
// ---------------------------------------------------------------------------
function createTurn(text, images) {
  const article = el('article', { class: 'turn' });
  article.append(renderAsk(text, images || []));
  const process = buildProcess();
  const out = el('div', { class: 'turn-out' });
  article.append(process.root, out);
  els.log.append(article);
  return {
    article,
    process,
    out,
    steps: new Map(),
    kinds: [],
    failCount: 0,
    think: null,
    answer: null,
    answerText: '',
    stamped: false,
    timer: null,
    startedAt: Date.now(),
  };
}

function renderAsk(text, images) {
  const { main, files } = X.parseAskText(text);
  const ask = el('div', { class: 'ask' });
  if (main) {
    const t = el('div', { class: 'ask-text', text: main });
    decorateIds(t);
    ask.append(t);
  }
  if (images.length || files.length) {
    const box = el('div', { class: 'ask-files' });
    for (const src of images) {
      const b = el('button', { type: 'button', class: 'ask-img', 'aria-label': '查看截图' }, [el('img', { src, alt: '' })]);
      b.addEventListener('click', () => openImage(src));
      box.append(b);
    }
    for (const f of files) box.append(fileChip(f));
    ask.append(box);
  }
  return ask;
}

function fileChip(f) {
  const lines = f.content ? f.content.split('\n').length : 0;
  const wrap = el('div', { class: 'file-chip' });
  const head = el('button', { type: 'button', class: 'file-chip-head', 'aria-expanded': 'false' }, [
    icon('file'),
    el('span', { class: 'file-chip-name', text: f.name }),
    el('span', { class: 'file-chip-meta', text: `${lines} 行` }),
  ]);
  const body = el('pre', { class: 'file-chip-body', hidden: true, text: f.content });
  head.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    wrap.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
  });
  wrap.append(head, body);
  return wrap;
}

// ---- 排查过程 ----
function buildProcess() {
  const count = el('span', { class: 'process-count' });
  const kinds = el('span', { class: 'process-kinds' });
  const fail = el('span', { class: 'process-fail' });
  const head = el('button', { type: 'button', class: 'process-head', 'aria-expanded': 'true', hidden: true }, [
    icon('chev', 'chev'),
    el('span', { class: 'process-title', text: '排查过程' }),
    count,
    kinds,
    fail,
  ]);
  const list = el('ol', { class: 'steps' });
  const statusText = el('span', { class: 'status-text' });
  const statusTime = el('span', { class: 'status-time' });
  const status = el('div', { class: 'status', hidden: true }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), statusText, statusTime]);
  const root = el('section', { class: 'process', 'aria-label': '排查过程' }, [head, list, status]);
  head.addEventListener('click', () => setProcessOpen({ process: p }, head.getAttribute('aria-expanded') !== 'true'));
  const p = { root, head, list, count, kinds, fail, status, statusText, statusTime };
  return p;
}

function setProcessOpen(ctx, open) {
  ctx.process.head.setAttribute('aria-expanded', String(open));
  ctx.process.list.hidden = !open;
}

function kindSummary(kinds) {
  const counts = new Map();
  for (const k of kinds) counts.set(k, (counts.get(k) || 0) + 1);
  return Array.from(counts, ([k, n]) => (n > 1 ? `${X.KIND_TEXT[k] || k} ${n} 次` : X.KIND_TEXT[k] || k)).join('、');
}

function updateProcessHead(ctx) {
  const p = ctx.process;
  const n = ctx.kinds.length;
  p.head.hidden = n === 0 && p.list.children.length === 0;
  p.count.textContent = n ? `${n} 步` : '';
  p.kinds.textContent = kindSummary(ctx.kinds);
  p.fail.textContent = ctx.failCount ? `${ctx.failCount} 步没查成` : '';
}

const STEP_ICONS = { ok: 'check', empty: 'minus', fail: 'alert', think: 'think', note: 'dot', warn: 'alert' };

function stepIcon(kind) {
  if (kind === 'running') return el('span', { class: 'spinner', 'aria-hidden': 'true' });
  return icon(STEP_ICONS[kind] || 'dot');
}

function addToolStep(ctx, toolCall) {
  const args = parseArgs(toolCall.arguments);
  const d = X.describeToolStep(toolCall.name, args);
  const title = el('span', { class: 'step-title', text: d.title });
  const head = el('button', { type: 'button', class: 'step-head', 'aria-expanded': 'false' }, [
    el('span', { class: 'step-icon' }, stepIcon('running')),
    title,
    el('span', { class: 'step-result' }),
  ]);
  decorateIds(title); // 标题在按钮里：单号只分组显示，点击仍是展开步骤
  const li = el('li', { class: 'step', 'data-state': 'running', 'data-kind': d.kind }, [head]);
  li.raw = { name: toolCall.name, args, result: null };
  head.addEventListener('click', () => toggleStepDetail(li, head));
  ctx.process.list.append(li);
  if (toolCall.id) ctx.steps.set(toolCall.id, li);
  ctx.kinds.push(d.kind);
  updateProcessHead(ctx);
  return li;
}

function setStepState(li, summary) {
  li.dataset.state = summary.state;
  li.querySelector('.step-icon').replaceChildren(stepIcon(summary.state));
  li.querySelector('.step-result').textContent = summary.text || '';
}

function completeToolStep(ctx, id, result, isError) {
  const li = ctx.steps.get(id);
  if (!li) return;
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  li.raw.result = text;
  const summary = X.summarizeToolResult(li.raw.name, li.raw.args, text, isError);
  setStepState(li, summary);
  if (summary.state === 'fail') ctx.failCount++;
  const detail = li.querySelector('.step-detail');
  if (detail) detail.replaceWith(buildStepDetail(li));
  updateProcessHead(ctx);
}

function prettyJson(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? JSON.stringify(data, null, 2) : text;
  } catch {
    return text;
  }
}

function dataTable(data) {
  const wrap = el('div', { class: 'detail-table' });
  for (const n of Array.isArray(data.notes) ? data.notes : []) wrap.append(el('p', { class: 'detail-note', text: n }));
  const rows = data.rows.slice(0, 100);
  const table = el('table', null, [
    el('thead', null, [el('tr', null, data.columns.map((c) => el('th', { text: c })))]),
    el(
      'tbody',
      null,
      rows.map((row) => el('tr', null, row.map((v) => el('td', { class: v == null ? 'is-null' : null, text: v == null ? 'NULL' : String(v) }))))
    ),
  ]);
  wrap.append(el('div', { class: 'table-wrap' }, [table]));
  if (Array.isArray(data.allNullColumns) && data.allNullColumns.length) {
    wrap.append(el('p', { class: 'detail-note', text: `以下列全部为空，未展示：${data.allNullColumns.join('、')}` }));
  }
  return wrap;
}

function buildStepDetail(li) {
  const { name, args, result } = li.raw;
  const detail = el('div', { class: 'step-detail' });
  if (name === 'company_db_query' && args.sql) {
    detail.append(el('div', { class: 'detail-label', text: '查询语句' }), el('pre', { class: 'detail-pre', text: args.sql }));
  } else {
    detail.append(el('div', { class: 'detail-label', text: '参数' }), el('pre', { class: 'detail-pre', text: JSON.stringify(args, null, 2) }));
  }
  detail.append(el('div', { class: 'detail-label', text: '返回结果' }));
  if (result == null) {
    detail.append(el('p', { class: 'detail-note', text: '还在执行…' }));
  } else {
    let data = null;
    if (name === 'company_db_query') {
      try {
        data = JSON.parse(result);
      } catch {
        data = null;
      }
    }
    if (data && Array.isArray(data.columns) && Array.isArray(data.rows)) detail.append(dataTable(data));
    else detail.append(el('pre', { class: 'detail-pre', text: prettyJson(result) }));
  }
  return detail;
}

function toggleStepDetail(li, head) {
  let detail = li.querySelector('.step-detail');
  if (!detail) {
    detail = buildStepDetail(li);
    detail.hidden = true;
    li.append(detail);
  }
  detail.hidden = !detail.hidden;
  head.setAttribute('aria-expanded', String(!detail.hidden));
}

function addNoteStep(ctx, text, tone) {
  const body = mdBlock(text, 'note-body');
  decorateIds(body);
  const li = el('li', { class: 'step step-note', 'data-tone': tone || null }, [
    el('span', { class: 'step-icon' }, stepIcon(tone === 'warn' ? 'warn' : 'note')),
    body,
  ]);
  ctx.process.list.append(li);
  // 较长的说明默认折叠成三行，点击展开
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 4) {
      li.classList.add('is-clamped');
      li.addEventListener('click', () => li.classList.remove('is-clamped'), { once: true });
    }
  });
  updateProcessHead(ctx);
}

function thinkAppend(ctx, chunk) {
  if (!ctx.think) {
    const body = el('div', { class: 'step-detail think-body', hidden: true });
    const head = el('button', { type: 'button', class: 'step-head', 'aria-expanded': 'false' }, [
      el('span', { class: 'step-icon' }, stepIcon('running')),
      el('span', { class: 'step-title', text: '正在思考' }),
      el('span', { class: 'step-result' }),
    ]);
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', String(!body.hidden));
    });
    const li = el('li', { class: 'step step-think', 'data-state': 'running' }, [head, body]);
    ctx.process.list.append(li);
    ctx.think = { li, body, text: '' };
    updateProcessHead(ctx);
  }
  ctx.think.text += chunk;
  ctx.think.body.textContent = ctx.think.text;
}

function endThink(ctx) {
  const t = ctx.think;
  if (!t) return;
  t.li.dataset.state = 'ok';
  t.li.querySelector('.step-icon').replaceChildren(stepIcon('think'));
  t.li.querySelector('.step-title').textContent = '思考过程';
  t.li.querySelector('.step-result').textContent = `${t.text.length} 字`;
  ctx.think = null;
}

// ---- 进度提示 ----
const STATUS_TEXT = {
  start: '正在理解问题…',
  think: '正在分析…',
  write: '正在整理回答…',
  order: '正在定位单号…',
  db: '正在查数据库…',
  logs: '正在查日志…',
  code: '正在看代码…',
  file: '正在看代码…',
  git: '正在查修改记录…',
  graph: '正在查代码调用关系…',
  web: '正在查网络资料…',
  plan: '正在整理排查计划…',
  ask: '等你回答上面的问题…',
  approve: '等你批准上面的操作…',
  edit: '正在修改文件…',
  command: '正在执行命令…',
  other: '正在排查…',
  reconnect: '和本地服务的连接断开了，正在从后台取回结果…',
  background: '后台还在排查这个问题，完成后会自动显示结果…',
};

function setStatus(ctx, kind) {
  ctx.process.statusText.textContent = STATUS_TEXT[kind] || STATUS_TEXT.other;
}

function tickStatus(ctx) {
  const s = Math.max(0, Math.round((Date.now() - ctx.startedAt) / 1000));
  ctx.process.statusTime.textContent = s < 60 ? `已用 ${s} 秒` : `已用 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function startStatus(ctx) {
  ctx.process.status.hidden = false;
  setStatus(ctx, 'start');
  tickStatus(ctx);
  ctx.timer = setInterval(() => tickStatus(ctx), 1000);
}

function stopStatus(ctx) {
  clearInterval(ctx.timer);
  ctx.timer = null;
  ctx.process.status.hidden = true;
}

// ---- 回答 ----
function ensureAnswer(ctx) {
  if (ctx.answer) return ctx.answer;
  const pre = el('div', { class: 'md answer-pre', hidden: true });
  const body = el('div', { class: 'answer-body' });
  const card = el('section', { class: 'answer', 'aria-label': '回答' }, [pre, body]);
  ctx.out.append(card);
  ctx.answer = { card, pre, body, verdict: null, foot: null };
  return ctx.answer;
}

function removeAnswer(ctx) {
  if (!ctx.answer) return;
  ctx.answer.card.remove();
  ctx.answer = null;
  ctx.stamped = false;
}

function renderSection(s) {
  const row = el('div', { class: `row row-${s.kind}` }, [el('h3', { class: 'row-label', text: s.label })]);
  const cell = el('div', { class: 'row-body' });
  if (s.kind === 'script') {
    const box = mdBlock(s.body.replace(/^[ \t]*>[ \t]?/gm, ''), 'script');
    const copy = el('button', { type: 'button', class: 'copy-btn' }, [icon('copy'), el('span', { class: 'copy-label', text: '复制话术' })]);
    copy.addEventListener('click', () => copyText(box.innerText.trim(), '话术已复制', copy));
    cell.append(box, copy);
  } else if (s.kind === 'conclusion') {
    cell.append(mdBlock(X.stripVerdictPrefix(s.title, s.body)));
  } else {
    cell.append(mdBlock(s.body));
  }
  row.append(cell);
  return row;
}

function setSeal(ctx, verdict, animate) {
  const a = ctx.answer;
  if (!a || a.verdict === verdict) return;
  a.verdict = verdict;
  let seal = a.card.querySelector(':scope > .seal');
  if (!verdict) {
    if (seal) seal.remove();
    a.card.removeAttribute('data-verdict');
    return;
  }
  if (!seal) {
    seal = el('div', { class: 'seal' });
    a.card.prepend(seal);
  }
  seal.dataset.v = verdict;
  seal.textContent = REVIEW_TEXT[verdict];
  seal.title = REVIEW_TEXT[verdict];
  a.card.dataset.verdict = verdict;
  // 印章只在实时回答第一次出现时"盖"下去；回放历史时直接显示
  if (animate && !ctx.stamped) {
    ctx.stamped = true;
    seal.classList.add('stamp');
  }
}

function renderAnswer(ctx, text, animate) {
  const a = ensureAnswer(ctx);
  const { preamble, sections } = X.splitSections(text);
  const structured = sections.length > 0;
  a.card.classList.toggle('is-plain', !structured);
  a.pre.hidden = !(structured && preamble);
  a.pre.innerHTML = structured && preamble ? X.renderMarkdown(preamble) : '';
  a.body.replaceChildren(...(structured ? sections.map(renderSection) : [mdBlock(text)]));
  const c = sections.find((s) => s.kind === 'conclusion');
  setSeal(ctx, ctx.publicReviewStatus || (state.mode === 'business' ? 'unreviewed' : null), animate);
  decorateIds(a.card);
}

function addAnswerFooter(ctx, text) {
  const a = ctx.answer;
  if (!a || a.foot) return;
  const copyAll = el('button', { type: 'button', class: 'foot-btn' }, [icon('copy'), el('span', { class: 'copy-label', text: '复制回答' })]);
  copyAll.addEventListener('click', () => copyText(X.toPlainText(text), '回答已复制', copyAll));
  const flag = el('button', { type: 'button', class: 'foot-btn foot-flag' }, [icon('flag'), '回答有误']);
  flag.addEventListener('click', () => openFeedback());
  a.foot = el('footer', { class: 'answer-foot' }, [copyAll, flag]);
  a.card.append(a.foot);
}

function addNotice(ctx, text) {
  ctx.out.append(el('div', { class: 'notice', role: 'alert' }, [icon('alert'), el('span', { text })]));
}

/** 一轮结束：收起排查过程、补上回答操作；回放历史与实时回答共用 */
function finalizeTurn(ctx, text, live) {
  stopStatus(ctx);
  endThink(ctx);
  for (const li of ctx.steps.values()) {
    if (li.dataset.state === 'running') setStepState(li, { state: 'empty', text: live ? '没有返回结果' : '没有记录结果' });
  }
  for (const gate of ctx.out.querySelectorAll('.gate')) {
    gate.querySelectorAll('button, input').forEach((b) => {
      b.disabled = true;
    });
    gate.classList.add('is-expired');
    gate.append(el('p', { class: 'gate-expired', text: '这一轮已经结束，不需要再操作。' }));
  }
  if (text && text.trim()) {
    renderAnswer(ctx, text, false);
    addAnswerFooter(ctx, text);
  } else if (!ctx.out.querySelector('.notice')) {
    addNotice(ctx, '这次没有得到回答。可以补充单号、发生时间或截图后再问一次。');
  }
  if (ctx.answer && ctx.process.list.children.length) setProcessOpen(ctx, false);
  updateProcessHead(ctx);
}

// ---- 审批与提问 ----
const GATE_TOOL_TEXT = { edit_file: '修改文件', write_file: '写入文件', run_powershell: '执行命令' };

async function postJson(url, payload) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
}

function addApprovalCard(ctx, request) {
  setStatus(ctx, 'approve');
  const approve = el('button', { type: 'button', class: 'btn btn-primary' }, '批准执行');
  const reject = el('button', { type: 'button', class: 'btn' }, '不执行');
  const card = el('div', { class: 'gate', role: 'group', 'aria-label': '需要你批准' }, [
    el('h3', { class: 'gate-title', text: '需要你批准' }),
    el('p', { class: 'gate-what' }, [`${GATE_TOOL_TEXT[request.toolName] || request.toolName || '操作'}：`, el('strong', { text: request.filePath || '' })]),
    request.summary ? el('p', { class: 'gate-summary', text: request.summary }) : null,
    request.diffPreview ? el('pre', { class: 'gate-diff', text: request.diffPreview }) : null,
    el('div', { class: 'gate-actions' }, [approve, reject]),
  ]);
  const decide = async (approved) => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      await postJson(`/api/session/${encodeURIComponent(state.sessionId)}/approve`, { requestId: request.id, approved });
      card.remove();
      setStatus(ctx, 'other');
    } catch (err) {
      approve.disabled = false;
      reject.disabled = false;
      toast(`提交失败：${err.message}`);
    }
  };
  approve.addEventListener('click', () => decide(true));
  reject.addEventListener('click', () => decide(false));
  ctx.out.append(card);
  maybeScroll();
}

function addQuestionCard(ctx, request) {
  setStatus(ctx, 'ask');
  const card = el('div', { class: 'gate gate-question', role: 'group', 'aria-label': '需要你确认' }, [el('h3', { class: 'gate-title', text: '需要你确认' })]);
  const controls = [];
  const input = el('input', { type: 'text', class: 'q-input', placeholder: '或者直接写下你的回答，按 Enter 发送', 'aria-label': '你的回答' });
  const send = el('button', { type: 'button', class: 'btn btn-primary' }, '回复');
  const submit = async (answer) => {
    const text = String(answer || '').trim();
    if (!text) {
      toast('请先写下你的回答');
      input.focus();
      return;
    }
    controls.forEach((c) => {
      c.disabled = true;
    });
    try {
      await postJson(`/api/session/${encodeURIComponent(state.sessionId)}/answer`, { requestId: request.id, answer: text });
      card.remove();
      setStatus(ctx, 'think');
    } catch (err) {
      controls.forEach((c) => {
        c.disabled = false;
      });
      toast(`提交失败：${err.message}`);
    }
  };
  for (const q of Array.isArray(request.questions) ? request.questions : []) {
    card.append(el('p', { class: 'gate-q', text: `${q.header ? `${q.header}：` : ''}${q.question || ''}` }));
    const options = Array.isArray(q.options) ? q.options : [];
    if (!options.length) continue;
    const list = el('div', { class: 'q-options' });
    for (const o of options) {
      const b = el('button', { type: 'button', class: 'q-option' }, [
        el('span', { class: 'q-option-label', text: o.label }),
        o.description ? el('span', { class: 'q-option-desc', text: o.description }) : null,
      ]);
      b.addEventListener('click', () => submit(o.label));
      controls.push(b);
      list.append(b);
    }
    card.append(list);
  }
  controls.push(input, send);
  send.addEventListener('click', () => submit(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit(input.value);
    }
  });
  card.append(el('div', { class: 'q-reply' }, [input, send]));
  ctx.out.append(card);
  maybeScroll();
  setTimeout(() => input.focus({ preventScroll: true }), 50);
}

// ---------------------------------------------------------------------------
// 附件（选择文件 / 拖拽 / Ctrl+V 粘贴截图）
// ---------------------------------------------------------------------------
// 只接受可以按文本读取的附件：zip/pdf/xlsx/docx 等二进制文件按文本读会变成大段乱码塞进对话
const TEXT_ATTACHMENT_EXTS = new Set(['txt', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'md', 'sql', 'java', 'js', 'ts', 'vue', 'html', 'htm', 'css', 'properties', 'conf', 'ini', 'sh', 'bat', 'py', 'jsp', 'out']);
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isTextAttachment(file) {
  const ext = (String(file.name || '').split('.').pop() || '').toLowerCase();
  return TEXT_ATTACHMENT_EXTS.has(ext) || String(file.type || '').startsWith('text/');
}

function looksBinaryText(text) {
  if (!text) return false;
  if (text.includes(String.fromCharCode(0))) return true;
  const bad = text.split(String.fromCharCode(0xfffd)).length - 1;
  return bad > 20 && bad / text.length > 0.01;
}

function handleFiles(files) {
  for (const file of files) {
    const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    if (String(file.type || '').startsWith('image/')) {
      if (file.size > MAX_IMAGE_BYTES) {
        toast(`「${file.name}」超过 10MB，请只截取有问题的区域`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.attachments.push({ id, name: file.name || `截图_${Date.now()}.png`, type: file.type, size: file.size, isImage: true, dataUrl: ev.target.result });
        renderAttachments();
      };
      reader.readAsDataURL(file);
      continue;
    }
    if (!isTextAttachment(file)) {
      toast(`暂时读不了「${file.name}」这类文件（压缩包、PDF、Excel、Word 等）。请截图，或把其中的文字复制进来`);
      continue;
    }
    if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      toast(`「${file.name}」超过 512KB，请只粘贴和问题相关的部分`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const textContent = String(ev.target.result || '');
      if (looksBinaryText(textContent)) {
        toast(`「${file.name}」不是文本文件，已跳过`);
        return;
      }
      state.attachments.push({ id, name: file.name, type: file.type, size: file.size, isImage: false, textContent });
      renderAttachments();
    };
    reader.readAsText(file);
  }
}

function formatSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}

function renderAttachments() {
  const box = els.attachments;
  box.replaceChildren();
  box.hidden = state.attachments.length === 0;
  for (const att of state.attachments) {
    let preview;
    if (att.isImage) {
      preview = el('button', { type: 'button', class: 'att-thumb', 'aria-label': `查看 ${att.name}` }, [el('img', { src: att.dataUrl, alt: '' })]);
      preview.addEventListener('click', () => openImage(att.dataUrl));
    } else {
      preview = el('span', { class: 'att-thumb att-file' }, [icon('file')]);
    }
    const remove = el('button', { type: 'button', class: 'att-remove', 'aria-label': `移除 ${att.name}`, title: '移除' }, [icon('x')]);
    remove.addEventListener('click', () => removeAttachment(att.id));
    box.append(
      el('div', { class: 'att' }, [
        preview,
        el('span', { class: 'att-meta' }, [el('span', { class: 'att-name', text: att.name, title: att.name }), el('span', { class: 'att-size', text: formatSize(att.size) })]),
        remove,
      ])
    );
  }
  updateSendState();
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
  els.input.focus();
}

// ---------------------------------------------------------------------------
// 发送与流式接收
// ---------------------------------------------------------------------------
let run = null;

function setBusy(busy) {
  state.busy = busy;
  document.title = busy ? '排查中… - 小康客服助手' : '小康客服助手';
  els.sendBtn.setAttribute('aria-label', busy ? '正在排查' : '发送');
  els.sendBtn.classList.toggle('is-busy', busy);
  updateSendState();
}

function updateSendState() {
  const hasContent = els.input.value.trim().length > 0 || state.attachments.length > 0;
  els.sendBtn.disabled = state.busy || !hasContent || state.health === 'offline';
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  updateSendState();
}

// 程序触发的滚动不改变"是否跟随到底部"的判断，只有客服自己滚动才改变
let autoScrolling = false;
function setScrollTop(value) {
  autoScrolling = true;
  els.scroller.scrollTop = value;
  requestAnimationFrame(() => {
    autoScrolling = false;
  });
}

function offsetInScroller(node) {
  const s = els.scroller;
  return node.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
}

/** 跟随最新内容；回答出现后让结论停在视野里，后面的依据在下方继续输出 */
function maybeScroll() {
  if (!state.follow) return;
  const s = els.scroller;
  let target = s.scrollHeight - s.clientHeight;
  const card = run && run.ctx.answer && run.ctx.answer.card;
  if (card) target = Math.min(target, offsetInScroller(card) - 56);
  setScrollTop(Math.max(0, target));
}

function scrollToBottom() {
  state.follow = true;
  setScrollTop(els.scroller.scrollHeight);
}

/** 打开会话或一轮结束时：最后一轮较长时停在它的开头（提问 + 结论），而不是回答的末尾 */
function revealLastTurn() {
  const s = els.scroller;
  const turn = els.log.lastElementChild;
  const bottom = s.scrollHeight - s.clientHeight;
  setScrollTop(turn ? Math.max(0, Math.min(bottom, offsetInScroller(turn) - 20)) : bottom);
  state.follow = s.scrollTop >= bottom - 80;
}

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const resp = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  state.sessionId = data.sessionId;
  setHash(data.sessionId);
  return state.sessionId;
}

async function sendMessage() {
  const text = els.input.value;
  const atts = state.attachments.slice();
  if (!text.trim() && !atts.length) return;
  if (state.busy) {
    toast('上一个问题还在排查，完成后再发送');
    return;
  }
  if (state.health === 'offline') {
    toast('本地服务已停止，请重新打开 xhang 后刷新本页');
    return;
  }

  const images = atts.filter((a) => a.isImage);
  let fullText = text;
  for (const f of atts.filter((a) => !a.isImage)) {
    fullText += `\n\n[附件文件: ${f.name}]\n\`\`\`\n${f.textContent || ''}\n\`\`\``;
  }

  viewToken++;
  showLog();
  const ctx = createTurn(fullText, images.map((i) => i.dataUrl));
  els.input.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  setBusy(true);
  run = { ctx, draft: '', started: false, streamEnded: false, rafPending: false };
  startStatus(ctx);
  scrollToBottom();

  try {
    const sessionId = await ensureSession();
    const body = images.length
      ? {
          parts: [
            { type: 'text', text: fullText || '请根据附件截图分析业务异常：' },
            ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } })),
          ],
        }
      : { message: fullText };
    const resp = await fetch(`/api/session/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    run.started = true;
    loadSessions(); // 服务端在开始排查前就保存了标题，先刷新列表让新会话出现
    await consumeSse(resp, handleEvent);
  } catch (err) {
    if (!run.started) {
      addNotice(ctx, `没有发出去：${err.message}`);
      run.streamEnded = true;
      // 把输入还给客服，方便直接重试
      if (!els.input.value) {
        els.input.value = text;
        state.attachments = atts;
        renderAttachments();
        autosize();
      }
    }
  } finally {
    await finishRun();
  }
}

async function consumeSse(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue; // 忽略坏帧
        }
        onEvent(ev);
      }
    }
  }
}

// harness 插入到回答流里的过程提示：不属于回答正文，放进排查过程
const HARNESS_NOTICES = [
  { re: /上面的回答缺少查询证据支撑/, discard: true, text: '上一版回答没有查询证据支撑，正在重新整理', tone: 'warn' },
  { re: /正在自动升级至深度排障引擎/, discard: true, text: '需要查内部数据，已转入深度排查' },
  { re: /检测到数据查询通道连续异常/, discard: false, text: '数据库连续查询失败，正在换一种方式排查', tone: 'warn' },
];

function flushRender(r) {
  if (!r.draft.trim()) return;
  renderAnswer(r.ctx, r.draft, true);
  maybeScroll();
}

function scheduleRender(r) {
  if (r.rafPending) return;
  r.rafPending = true;
  requestAnimationFrame(() => {
    r.rafPending = false;
    if (run === r) flushRender(r);
  });
}

// 模型在调用工具前说的话（"我先查一下订单"）不是最终回答，挪进排查过程
function moveDraftToNote(r) {
  const text = r.draft.trim();
  r.draft = '';
  removeAnswer(r.ctx);
  if (text && !X.isPlaceholderReply(text)) addNoteStep(r.ctx, text);
}

function onContentChunk(r, chunk) {
  const notice = HARNESS_NOTICES.find((n) => n.re.test(chunk));
  if (notice) {
    if (notice.discard) {
      r.draft = '';
      removeAnswer(r.ctx);
    } else {
      moveDraftToNote(r);
    }
    addNoteStep(r.ctx, notice.text, notice.tone);
    return;
  }
  r.draft += chunk;
  endThink(r.ctx);
  setStatus(r.ctx, 'write');
  scheduleRender(r);
}

function handleEvent(ev) {
  const r = run;
  if (!r || !ev || !ev.type) return;
  const ctx = r.ctx;
  if (state.mode === 'business' && !['progress', 'question', 'answer', 'error', 'done'].includes(ev.type)) return;
  switch (ev.type) {
    case 'progress': {
      const label = { checking: '正在核对业务记录', reviewing: '正在复核业务结论', revising: '正在补充核实' }[ev.phase];
      if (label && r.phase !== ev.phase) { addNoteStep(ctx, label); r.phase = ev.phase; }
      setStatus(ctx, 'think');
      break;
    }
    case 'question':
      addQuestionCard(ctx, ev.question);
      break;
    case 'answer': {
      const a = ev.answer;
      ctx.publicReviewStatus = a.reviewStatus;
      r.draft = [`【结论】\n${a.conclusion}`,
        ...(a.businessData.length ? [`【业务信息】\n${a.businessData.map(v => `${v.label}：${v.value}`).join('\n')}`] : []),
        ...(a.evidenceSummary.length ? [`【依据】\n${a.evidenceSummary.join('\n')}`] : []),
        ...(a.customerReply ? [`【客服话术】\n${a.customerReply}`] : []),
        ...(a.pendingItems.length ? [`【还需确认】\n${a.pendingItems.join('\n')}`] : [])].join('\n\n');
      flushRender(r);
      break;
    }
    case 'reasoning_chunk':
      thinkAppend(ctx, ev.chunk || '');
      if (!r.draft) setStatus(ctx, 'think');
      break;
    case 'content_chunk':
      onContentChunk(r, String(ev.chunk || ''));
      break;
    case 'tool_call_start': {
      moveDraftToNote(r);
      endThink(ctx);
      const tc = ev.toolCall || {};
      addToolStep(ctx, tc);
      setStatus(ctx, X.describeToolStep(tc.name, parseArgs(tc.arguments)).kind);
      break;
    }
    case 'tool_call_result':
      completeToolStep(ctx, ev.toolCallId, ev.result, ev.isError);
      setStatus(ctx, 'think');
      break;
    case 'approval_requested':
      addApprovalCard(ctx, ev.request || {});
      break;
    case 'question_requested':
      addQuestionCard(ctx, ev.request || {});
      break;
    case 'error':
      addNotice(ctx, `出错了：${ev.message || ev.error || '请求未完成'}`);
      break;
    case 'done': {
      if (state.mode === 'business') { r.streamEnded = true; endThink(ctx); break; }
      endThink(ctx);
      // done 带的是服务端保存的最终回答，以它为准（中途被要求重写的草稿会被替换掉）
      const finalText = X.contentText(ev.finalMessage && ev.finalMessage.content);
      if (finalText.trim()) r.draft = finalText;
      flushRender(r);
      break;
    }
    case 'stream_end':
      r.streamEnded = true;
      break;
    default:
      break;
  }
  maybeScroll();
}

async function waitForServerIdle(id, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const resp = await fetch(`/api/session/${encodeURIComponent(id)}`);
      if (resp.ok) {
        const data = await resp.json();
        if (!data.busy) return data;
      }
    } catch {
      /* 网络仍不通则继续等待下一轮 */
    }
    await sleep(3000);
  }
  return null;
}

async function finishRun() {
  const r = run;
  if (r) {
    const ctx = r.ctx;
    // SSE 中途断开：后台会继续跑完并保存，等它结束后整段重放
    if (r.started && !r.streamEnded && state.sessionId) {
      setStatus(ctx, 'reconnect');
      const data = await waitForServerIdle(state.sessionId, 10 * 60 * 1000);
      if (data) {
        stopStatus(ctx);
        run = null;
        setBusy(false);
        renderHistory(data.messages || [], { busy: false });
        revealLastTurn();
        await loadSessions();
        return;
      }
      addNotice(ctx, '和本地服务的连接断开了，后台可能还在排查。稍后在左侧重新打开这个会话查看结果。');
    }
    finalizeTurn(ctx, r.draft, true);
  }
  run = null;
  setBusy(false);
  if (state.follow) revealLastTurn();
  await loadSessions();
  els.input.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------
let modalReturnFocus = null;

function openModal(modal, focusEl) {
  modalReturnFocus = document.activeElement;
  modal.hidden = false;
  const target = focusEl || modal.querySelector('textarea, input, button');
  if (target) target.focus();
}

function closeModal(modal) {
  modal.hidden = true;
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function openImage(src) {
  els.imageModalImg.src = src;
  openModal(els.imageModal, els.imageModal);
}

let feedbackType = '排障结论错误';
const choices = Array.from(document.querySelectorAll('.choice'));

function pickChoice(c) {
  for (const x of choices) {
    const on = x === c;
    x.classList.toggle('is-on', on);
    x.setAttribute('aria-checked', String(on));
  }
  feedbackType = c.dataset.type;
}

function openFeedback() {
  els.feedbackContextTip.textContent = state.sessionId
    ? '会附带本次会话的提问、排查过程和回答，方便技术同事核查。'
    : '当前没有打开的会话，只会提交你填写的内容。';
  els.feedbackText.value = '';
  openModal(els.feedbackModal, els.feedbackText);
}

async function submitFeedback() {
  const content = els.feedbackText.value.trim();
  if (!content) {
    toast('请先写一下具体哪里不对');
    els.feedbackText.focus();
    return;
  }
  const btn = els.feedbackSubmit;
  btn.disabled = true;
  btn.textContent = '正在提交…';
  try {
    const resp = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, feedbackType, sessionId: state.sessionId || undefined }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    closeModal(els.feedbackModal);
    toast('反馈已提交，谢谢');
  } catch (err) {
    toast(`提交失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '提交反馈';
  }
}

// ---------------------------------------------------------------------------
// 侧边栏（窄屏时为抽屉）
// ---------------------------------------------------------------------------
function openSidebar() {
  document.body.classList.add('nav-open');
  els.menuBtn.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.body.classList.remove('nav-open');
  els.menuBtn.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
let composing = false;
els.input.addEventListener('compositionstart', () => {
  composing = true;
});
els.input.addEventListener('compositionend', () => {
  composing = false;
});
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  // 输入法拼音合成阶段不触发发送
  if (e.isComposing || composing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    sendMessage();
  }
});
els.input.addEventListener('paste', (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const files = items
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) {
    handleFiles(files);
    toast(`已添加 ${files.length} 张截图`);
  }
});
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
els.attachBtn.addEventListener('click', () => {
  els.fileInput.value = '';
  els.fileInput.click();
});
els.fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length) handleFiles(Array.from(e.target.files));
});

// 拖拽：整个主区域都可以放下文件
let dragDepth = 0;
const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
els.main.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.composer.classList.add('is-drop');
});
els.main.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
els.main.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.composer.classList.remove('is-drop');
});
els.main.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.composer.classList.remove('is-drop');
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) handleFiles(files);
});
// 拖到页面其他地方松开时，不要让浏览器直接打开文件
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

els.scroller.addEventListener(
  'scroll',
  () => {
    if (autoScrolling) return;
    const s = els.scroller;
    state.follow = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  },
  { passive: true }
);

for (const b of document.querySelectorAll('.example')) {
  b.addEventListener('click', () => {
    if (b.dataset.action === 'attach') {
      els.fileInput.value = '';
      els.fileInput.click();
      els.input.focus();
      return;
    }
    // 模板里的 | 是光标位置，客服直接接着输入单号
    const tpl = b.dataset.prompt || '';
    const at = tpl.indexOf('|');
    els.input.value = tpl.replace('|', '');
    autosize();
    els.input.focus();
    const pos = at >= 0 ? at : els.input.value.length;
    els.input.setSelectionRange(pos, pos);
  });
}

els.newSessionBtn.addEventListener('click', startNewSession);
els.menuBtn.addEventListener('click', () => (document.body.classList.contains('nav-open') ? closeSidebar() : openSidebar()));
els.scrim.addEventListener('click', closeSidebar);
els.helpBtn.addEventListener('click', () => openModal(els.helpModal));
els.versionBtn.addEventListener('click', () => checkUpdate(true));
els.checkUpdateBtn.addEventListener('click', () => checkUpdate(true));
els.doUpdateBtn.addEventListener('click', runUpdate);
els.dismissUpdateBtn.addEventListener('click', () => {
  els.updateBanner.hidden = true;
});
els.feedbackSubmit.addEventListener('click', submitFeedback);
choices.forEach((c) => c.addEventListener('click', () => pickChoice(c)));

for (const m of [els.feedbackModal, els.helpModal]) {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
  });
}
els.imageModal.addEventListener('click', () => closeModal(els.imageModal));

document.addEventListener('keydown', (e) => {
  const open = [els.imageModal, els.feedbackModal, els.helpModal].find((m) => !m.hidden);
  if (e.key === 'Escape') {
    if (open) closeModal(open);
    else if (document.body.classList.contains('nav-open')) closeSidebar();
    return;
  }
  // 弹窗打开时 Tab 只在弹窗内循环
  if (e.key === 'Tab' && open) {
    const focusables = Array.from(open.querySelectorAll('button, textarea, input, [tabindex="0"]')).filter((x) => !x.disabled && x.offsetParent !== null);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || !open.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  // 单号：Enter / 空格复制
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('oid') && e.target.dataset.id) {
    e.preventDefault();
    copyText(e.target.dataset.id, `单号 ${e.target.dataset.id} 已复制`);
  }
});

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.oid[data-id]');
  if (chip) {
    // 客服在拖选文字时不触发复制
    if (String(window.getSelection() || '').trim()) return;
    copyText(chip.dataset.id, `单号 ${chip.dataset.id} 已复制`);
    return;
  }
  const codeCopy = e.target.closest('.code-copy');
  if (codeCopy) {
    const pre = codeCopy.closest('.code').querySelector('pre');
    copyText(pre.innerText, '代码已复制', codeCopy);
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
bootstrap().then(() => {
  autosize();
  els.input.focus();
});
