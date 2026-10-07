/* xhang Web UI 前端核心交互
 * - 真实会话管理: 新建会话 / 历史会话列表 / 历史记录回溯与渲染
 * - 附件系统: +按钮选文件 / 拖拽 / 剪贴板 Ctrl+V 粘贴截图与日志
 * - Agent 流式输出: Markdown / 深度思考折叠 / 工具调用 / 审批门 / 提问门
 */
'use strict';

const state = {
  sessionId: null,
  activeModelDisplayName: '小康 TUI 业务排障底座',
  repoName: '',
  busy: false,
  attachments: [], // Array<{ id, name, type, size, dataUrl, isImage, textContent }>
};

const $ = (id) => document.getElementById(id);

const els = {
  welcome: $('welcome'),
  chat: $('chat'),
  msgList: $('msgList'),
  chatSessionTitle: $('chatSessionTitle'),
  chatStatusDot: $('chatStatusDot'),
  chatLiveBadge: $('chatLiveBadge'),
  modelStatusIndicator: $('modelStatusIndicator'),
  modelStatusText: $('modelStatusText'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  newChatBtn: $('newChatBtn'),
  newChatTopBtn: $('newChatTopBtn'),
  sessionList: $('sessionList'),
  sessionCount: $('sessionCount'),
  userName: $('userName'),
  userAvatar: $('userAvatar'),
  uploadBtn: $('uploadBtn'),
  fileInput: $('fileInput'),
  attachmentsRow: $('attachmentsRow'),
  composerCard: $('composerCard'),
  helpModal: $('helpModal'),
  toast: $('toast'),
  updateBanner: $('updateBanner'),
  updateBannerText: $('updateBannerText'),
  doUpdateBtn: $('doUpdateBtn'),
  clientVersionBadge: $('clientVersionBadge'),
  modalCheckUpdateBtn: $('modalCheckUpdateBtn'),
  modelBadgeStatus: $('modelBadgeStatus'),
};

// ---------------------------------------------------------------------------
// 提示与辅助工具
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1800);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(raw) {
  if (!raw) return '';
  const blocks = [];
  let text = escapeHtml(raw);

  // 代码块：增加语言标签、行数提示和可折叠交互
  text = text.replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    const cleanCode = code.replace(/\n$/, '');
    const lineCount = cleanCode.split('\n').length;
    const langLabel = (lang || 'code').toUpperCase();
    const isLong = lineCount > 6;
    const idx = blocks.push(`
      <div class="code-card ${isLong ? 'collapsible' : ''}">
        <div class="code-card-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="code-lang-tag">${langLabel}</span>
          <span class="code-meta">${lineCount} 行</span>
          <span class="code-toggle-hint">${isLong ? '展开/收起代码' : ''}</span>
        </div>
        <pre class="code-card-body"><code data-lang="${lang}">${cleanCode}</code></pre>
      </div>
    `) - 1;
    return `\u0000BLOCK${idx}\u0000`;
  });

  // 支持显式 <br> 换行标签
  text = text.replace(/&lt;br\s*\/?&gt;/gi, '<br>');

  // 行内代码
  text = text.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  // 标题（支持 #### 到 #）
  text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // 粗体中括号标题美化（如 【业务结论】、【排查建议】等）
  text = text.replace(/(?:^|\n)\s*【([^】]+)】/g, '\n<div class="section-title-badge"><span class="badge-icon">📌</span>$1</div>');
  // 加粗 / 斜体
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  // 链接
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 解析段落、列表、引用与表格
  const lines = text.split('\n');
  let html = '';
  let listOpen = false;
  let quoteOpen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. 表格检测 (当前行以 | 开头且结尾，下一行是分隔行 |:---|:---|)
    if (
      trimmed.startsWith('|') &&
      trimmed.endsWith('|') &&
      i + 1 < lines.length &&
      lines[i + 1].trim().startsWith('|') &&
      lines[i + 1].trim().endsWith('|') &&
      /^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[i + 1].trim())
    ) {
      if (listOpen) { html += '</ul>'; listOpen = false; }
      if (quoteOpen) { html += '</blockquote>'; quoteOpen = false; }

      const parseRow = (rowStr) => {
        return rowStr
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
      };

      const headerCells = parseRow(lines[i]);
      let tableRows = '';
      i += 2; // 跳过表头和分隔行

      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const rowCells = parseRow(lines[i]);
        tableRows += `<tr>${rowCells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
        i++;
      }
      i--; // 回退一行让外层循环继续正确步进

      html += `
        <div class="table-responsive">
          <table class="cs-table">
            <thead>
              <tr>${headerCells.map((h) => `<th>${h}</th>`).join('')}</tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>`;
      continue;
    }

    // 2. 标题
    if (/^<h[123]>/.test(trimmed)) {
      if (listOpen) { html += '</ul>'; listOpen = false; }
      if (quoteOpen) { html += '</blockquote>'; quoteOpen = false; }
      html += trimmed;
      continue;
    }

    // 3. 分割线
    if (/^---$|^___$/.test(trimmed)) {
      if (listOpen) { html += '</ul>'; listOpen = false; }
      if (quoteOpen) { html += '</blockquote>'; quoteOpen = false; }
      html += '<hr class="cs-divider">';
      continue;
    }

    // 4. 引用块
    if (/^>\s*/.test(trimmed)) {
      if (listOpen) { html += '</ul>'; listOpen = false; }
      if (!quoteOpen) { html += '<blockquote>'; quoteOpen = true; }
      html += `<p>${trimmed.replace(/^>\s*/, '')}</p>`;
      continue;
    } else if (quoteOpen) {
      html += '</blockquote>';
      quoteOpen = false;
    }

    // 5. 列表
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${trimmed.replace(/^([-*]|\d+\.)\s+/, '')}</li>`;
      continue;
    }
    if (listOpen) { html += '</ul>'; listOpen = false; }

    if (trimmed === '') continue;
    html += `<p>${line}</p>`;
  }

  if (listOpen) html += '</ul>';
  if (quoteOpen) html += '</blockquote>';

  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return html;
}

function autoScroll() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

window.triggerScreenshotUpload = function () {
  els.fileInput.value = '';
  els.fileInput.click();
};

window.fillPrompt = function (prompt) {
  els.input.value = prompt;
  autosizeInput();
  els.input.focus();
};

// ---------------------------------------------------------------------------
// 初始化与健康心跳探活 (实时感知本地/中台服务状态)
// ---------------------------------------------------------------------------
let currentServerHealth = 'unknown'; // 'ready' | 'warning' | 'offline'

function updateHealthUI(status, customText) {
  currentServerHealth = status;
  if (!els.modelStatusIndicator || !els.modelStatusText || !els.modelBadgeStatus) return;

  // 执行中时不覆盖转圈动效
  if (state.busy) return;

  if (status === 'ready') {
    els.modelBadgeStatus.className = 'model-badge-fixed';
    els.modelStatusIndicator.className = 'status-indicator-green';
    els.modelStatusText.textContent = customText || '智能客服底座 · 就绪';
    els.input.placeholder = '输入订单号、流水单号、业务报错，或直接按 Ctrl+V 粘贴用户报错截图...';
    if (!state.busy) els.input.disabled = false;
  } else if (status === 'warning') {
    els.modelBadgeStatus.className = 'model-badge-fixed warning';
    els.modelStatusIndicator.className = 'status-indicator-yellow';
    els.modelStatusText.textContent = customText || '公司中台 · 离线重连中';
    els.input.placeholder = '公司核心中台 (8600) 正在连接中，部分内部工具暂不可用...';
  } else if (status === 'offline') {
    els.modelBadgeStatus.className = 'model-badge-fixed offline';
    els.modelStatusIndicator.className = 'status-indicator-red';
    els.modelStatusText.textContent = customText || '本地服务 · 未启动';
    els.input.placeholder = '❌ 本地排障服务已断开，请双击 xhang.exe 重新启动客户端...';
    els.input.disabled = true;
    els.sendBtn.disabled = true;
  }
}

async function pollHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('/api/bootstrap', { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      updateHealthUI('offline');
      return;
    }
    const info = await resp.json();
    if (info.mcpConnected === false) {
      updateHealthUI('warning');
    } else {
      updateHealthUI('ready');
    }
  } catch {
    updateHealthUI('offline');
  }
}

async function bootstrap() {
  try {
    const resp = await fetch('/api/bootstrap');
    if (!resp.ok) {
      updateHealthUI('offline');
      return;
    }
    const info = await resp.json();
    state.repoName = info.repoName || '业务排障服务中心';
    state.activeModelDisplayName = info.activeModelDisplayName || '小康排障底座';

    const rawName = info.userName || '未绑定用户';
    if (els.userName) els.userName.textContent = rawName;

    // 智能提取头像文字 (如 "技术-张朝" 提取 "张", "客服-贾宇晨" 提取 "贾")
    let avatarChar = '服';
    const cleanName = rawName.replace(/^(技术|客服|运营|测试|二线客服)[-_/:]*/, '').trim();
    if (cleanName) {
      avatarChar = cleanName.charAt(0);
    } else if (rawName) {
      avatarChar = rawName.charAt(0);
    }
    if (els.userAvatar) els.userAvatar.textContent = avatarChar;

    if (info.mcpConnected === false) {
      updateHealthUI('warning');
    } else {
      updateHealthUI('ready');
    }

    await loadSessions();
    // 异步检测客户端是否有新版本
    checkUpdateInWeb();
    // 启动每 6 秒后台静默探活心跳
    setInterval(pollHealth, 6000);
  } catch (err) {
    updateHealthUI('offline');
    toast('本地服务未启动，正在等待连接...');
  }
}

// ---------------------------------------------------------------------------
// 客户端版本检测与在线一键更新 (带已下载就绪与重启提示状态管理)
// ---------------------------------------------------------------------------
let remoteUpdateInfo = null;

async function checkUpdateInWeb(isManual = false) {
  try {
    const resp = await fetch('/api/version/check');
    if (!resp.ok) return;
    const info = await resp.json();

    if (info.currentVersion && els.clientVersionBadge) {
      els.clientVersionBadge.textContent = `v${info.currentVersion}`;
    }

    const pendingVersion = localStorage.getItem('pending_restart_version');

    // 如果客户端重启后，当前版本已升级到目标版本，清除 pending 状态
    if (pendingVersion && info.currentVersion === pendingVersion) {
      localStorage.removeItem('pending_restart_version');
    }

    if (info.hasUpdate && info.latestVersion) {
      remoteUpdateInfo = info;
      
      // 如果当前最新版本已经下载替换完毕、正在等待重启
      if (pendingVersion === info.latestVersion) {
        els.updateBannerText.innerHTML = `✅ <b>客户端新版本 v${info.latestVersion} 已下载就绪！</b> 请关闭当前黑色终端窗口并重新打开生效。`;
        els.doUpdateBtn.textContent = '已下载就绪';
        els.doUpdateBtn.disabled = true;
        els.updateBanner.hidden = false;
        return;
      }

      const notes = Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0
        ? ` (${info.releaseNotes[0]})`
        : '';
      els.updateBannerText.textContent = `🚀 发现客户端新版本 v${info.latestVersion}${notes}，建议立即更新以获得最新排障逻辑！`;
      els.doUpdateBtn.textContent = '立即更新';
      els.doUpdateBtn.disabled = false;
      els.updateBanner.hidden = false;
      if (isManual) {
        toast(`🚀 发现新版本 v${info.latestVersion}，请点击顶部横幅更新`);
      }
    } else {
      els.updateBanner.hidden = true;
      localStorage.removeItem('pending_restart_version');
      if (isManual) {
        toast(`🎉 当前已是最新版本 (v${info.currentVersion || '1.1.71'})，无需更新！`);
      }
    }
  } catch (err) {
    if (isManual) {
      toast('检查更新失败: ' + err.message);
    }
  }
}

window.manualCheckUpdate = function () {
  checkUpdateInWeb(true);
};

window.triggerClientUpdate = async function () {
  if (!remoteUpdateInfo || !els.doUpdateBtn) return;
  els.doUpdateBtn.disabled = true;
  els.doUpdateBtn.textContent = '正在下载更新包…';

  try {
    const resp = await fetch('/api/version/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadUrl: remoteUpdateInfo.downloadUrl }),
    });
    const result = await resp.json();
    if (!resp.ok || !result.success) {
      throw new Error(result.message || '更新失败');
    }
    // 标记该版本已下载就绪，等待重启
    if (remoteUpdateInfo.latestVersion) {
      localStorage.setItem('pending_restart_version', remoteUpdateInfo.latestVersion);
    }
    els.updateBannerText.innerHTML = `✅ <b>更新包已下载替换完毕！</b> 请关闭当前客户端窗口，重新双击 xhang.exe 即可生效。`;
    els.doUpdateBtn.textContent = '已就绪 (需重启)';
    els.doUpdateBtn.disabled = true;
    toast('✅ 客户端已更新就绪，重启终端即可生效！');
  } catch (err) {
    els.doUpdateBtn.disabled = false;
    els.doUpdateBtn.textContent = '重试更新';
    toast('❌ 更新失败: ' + err.message);
  }
};

window.dismissUpdateBanner = function () {
  els.updateBanner.hidden = true;
};

// ---------------------------------------------------------------------------
// 会话管理 (新建会话、列表展示、历史回溯、删除)
// ---------------------------------------------------------------------------
async function loadSessions() {
  try {
    const resp = await fetch('/api/sessions');
    const data = await resp.json();
    const sessions = data.sessions || [];
    els.sessionCount.textContent = sessions.length;

    if (sessions.length === 0) {
      els.sessionList.innerHTML = `
        <div class="session-empty-state">
          <span class="session-empty-icon">📂</span>
          <span class="session-empty-text">暂无历史排障记录<br>点击上方按钮开启新会话</span>
        </div>`;
      return;
    }

    els.sessionList.innerHTML = sessions.map((s) => `
      <div class="session-item ${s.id === state.sessionId ? 'active' : ''}" data-id="${s.id}" title="${escapeHtml(s.title)}">
        <div class="session-info">
          <span class="session-title-text">${escapeHtml(s.title || '排障会话')}</span>
          <span class="session-meta-text">
            <span>${formatRelativeTime(s.lastActiveAt)}</span>
            <span>·</span>
            <span>${s.messageCount}条对话</span>
          </span>
        </div>
        <button class="session-del-btn" data-del="${s.id}" title="删除会话">✕</button>
      </div>
    `).join('');

    // 绑定点击事件
    els.sessionList.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        selectSession(item.dataset.id);
      });
    });

    els.sessionList.querySelectorAll('[data-del]').forEach((delBtn) => {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(delBtn.dataset.del);
      });
    });
  } catch (err) {
    console.error('加载历史会话失败:', err);
  }
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const now = new Date();
  const past = new Date(isoStr);
  const diffSec = Math.floor((now - past) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}

function startNewSession() {
  state.sessionId = null;
  state.busy = false;
  state.attachments = [];
  renderAttachments();
  
  els.msgList.innerHTML = '';
  els.chat.hidden = true;
  els.welcome.hidden = false;
  els.input.value = '';
  autosizeInput();
  els.input.focus();
  
  // 更新高亮
  els.sessionList.querySelectorAll('.session-item').forEach((item) => {
    item.classList.remove('active');
  });
}

async function selectSession(sessionId) {
  if (state.busy) {
    toast('当前有任务正在执行，请稍候再切换会话');
    return;
  }
  try {
    const resp = await fetch(`/api/session/${sessionId}`);
    if (!resp.ok) {
      toast('会话不存在或已删除');
      loadSessions();
      return;
    }
    const data = await resp.json();
    state.sessionId = data.id;
    els.chatSessionTitle.textContent = data.title || '排障会话';

    // 切换视图
    els.welcome.hidden = true;
    els.chat.hidden = false;
    els.msgList.innerHTML = '';

    // 回放历史消息
    renderHistoryMessages(data.messages || []);

    // 刷新侧边栏高亮
    els.sessionList.querySelectorAll('.session-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.id === sessionId);
    });

    autoScroll();
    els.input.focus();
  } catch (err) {
    toast('加载会话历史失败: ' + err.message);
  }
}

async function deleteSession(sessionId) {
  try {
    await fetch(`/api/session/${sessionId}`, { method: 'DELETE' });
    if (state.sessionId === sessionId) {
      startNewSession();
    }
    await loadSessions();
    toast('会话已删除');
  } catch (err) {
    toast('删除失败: ' + err.message);
  }
}

function renderHistoryMessages(messages) {
  for (const msg of messages) {
    if (msg.role === 'user') {
      const attachments = [];
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            text += part.text;
          } else if (part.type === 'image_url' && part.image_url?.url) {
            attachments.push({ isImage: true, dataUrl: part.image_url.url, name: '上传截图' });
          }
        }
      }
      addUserMessage(text, attachments);
    } else if (msg.role === 'assistant') {
      if (msg.reasoning_content) {
        const thinkingEl = addThinkingBlock();
        thinkingEl.textContent = msg.reasoning_content;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          addToolRow(tc);
        }
      }
      if (msg.content) {
        const bubble = addAssistantBubble();
        const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        bubble.innerHTML = renderMarkdown(contentStr);
      }
    } else if (msg.role === 'tool') {
      // 附加到对应工具调用结果
      const lastToolRow = els.msgList.querySelector('.tool-row:last-of-type');
      if (lastToolRow) {
        const resEl = lastToolRow.querySelector('.tool-result');
        if (resEl) resEl.textContent = msg.content || '(已完成)';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 附件处理 (文件选择 / 拖拽 / 剪贴板截图粘贴)
// ---------------------------------------------------------------------------
els.uploadBtn.addEventListener('click', () => {
  els.fileInput.value = '';
  els.fileInput.click();
});

els.fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    handleFiles(Array.from(e.target.files));
  }
});

// 监听输入框剪贴板粘贴(Ctrl+V 截图直接附加上传)
els.input.addEventListener('paste', (e) => {
  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;

  const items = Array.from(clipboardData.items || []);
  const imageItems = items.filter((item) => item.type.startsWith('image/'));

  if (imageItems.length > 0) {
    const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
    if (files.length > 0) {
      handleFiles(files);
      toast(`已捕获 ${files.length} 张截图附件`);
    }
  }
});

// 拖拽文件到输入区域
['dragenter', 'dragover'].forEach((eventName) => {
  els.composerCard.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.composerCard.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  els.composerCard.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.composerCard.classList.remove('drag-over');
  });
});

els.composerCard.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length > 0) {
    handleFiles(files);
    toast(`已添加 ${files.length} 个附件`);
  }
});

function handleFiles(files) {
  for (const file of files) {
    const attachId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const isImage = file.type.startsWith('image/');
    
    if (isImage) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.attachments.push({
          id: attachId,
          name: file.name || `截图_${Date.now()}.png`,
          type: file.type,
          size: file.size,
          isImage: true,
          dataUrl: ev.target.result,
        });
        renderAttachments();
        autosizeInput();
      };
      reader.readAsDataURL(file);
    } else {
      // 文本 / 日志 / 代码文件
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.attachments.push({
          id: attachId,
          name: file.name,
          type: file.type,
          size: file.size,
          isImage: false,
          textContent: ev.target.result,
        });
        renderAttachments();
        autosizeInput();
      };
      reader.readAsText(file);
    }
  }
}

function renderAttachments() {
  if (state.attachments.length === 0) {
    els.attachmentsRow.hidden = true;
    els.attachmentsRow.innerHTML = '';
    return;
  }

  els.attachmentsRow.hidden = false;
  els.attachmentsRow.innerHTML = state.attachments.map((att) => `
    <div class="attach-chip" id="${att.id}">
      ${att.isImage ? `<img src="${att.dataUrl}" class="attach-thumb" alt="预览" />` : '📄'}
      <span class="attach-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
      <span class="attach-remove-btn" onclick="removeAttachment('${att.id}')">✕</span>
    </div>
  `).join('');
}

window.removeAttachment = function (id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
  autosizeInput();
};

// ---------------------------------------------------------------------------
// 消息渲染函数
// ---------------------------------------------------------------------------
function addUserMessage(text, attachments = []) {
  const div = document.createElement('div');
  div.className = 'msg-user';

  if (attachments.length > 0) {
    const attWrap = document.createElement('div');
    attWrap.className = 'msg-user-attachments';
    for (const att of attachments) {
      if (att.isImage && att.dataUrl) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.className = 'user-img-thumb';
        img.alt = '用户上传截图';
        attWrap.appendChild(img);
      } else if (att.name) {
        const badge = document.createElement('span');
        badge.className = 'user-file-badge';
        badge.textContent = `📄 ${att.name}`;
        attWrap.appendChild(badge);
      }
    }
    div.appendChild(attWrap);
  }

  if (text) {
    const textEl = document.createElement('div');
    textEl.textContent = text;
    textEl.style.whiteSpace = 'pre-wrap';
    div.appendChild(textEl);
  }

  els.msgList.appendChild(div);
  autoScroll();
  return div;
}

function addAssistantBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'msg-assistant';
  els.msgList.appendChild(wrap);
  return wrap;
}

function addThinkingBlock() {
  const block = document.createElement('div');
  block.className = 'thinking-block';
  block.innerHTML = `
    <span class="thinking-toggle"><span class="arrow">▸</span> 思考过程</span>
    <div class="thinking-body"></div>`;
  const toggle = block.querySelector('.thinking-toggle');
  const body = block.querySelector('.thinking-body');
  toggle.addEventListener('click', () => {
    body.classList.toggle('open');
    block.querySelector('.arrow').textContent = body.classList.contains('open') ? '▾' : '▸';
  });
  els.msgList.appendChild(block);
  autoScroll();
  return body;
}

function addToolRow(toolCall) {
  const row = document.createElement('div');
  row.className = 'tool-row running';
  let argsPreview = '';
  try {
    const args = typeof toolCall.arguments === 'string'
      ? JSON.parse(toolCall.arguments) : (toolCall.arguments || {});
    argsPreview = Object.entries(args)
      .map(([k, v]) => `${k}=${String(JSON.stringify(v)).slice(0, 60)}`)
      .join(', ');
  } catch {
    argsPreview = String(toolCall.arguments || '').slice(0, 80);
  }
  row.innerHTML = `
    <span class="tool-head">⚡ <span class="tool-name">${escapeHtml(toolCall.name)}</span>(<span class="tool-args">${escapeHtml(argsPreview)}</span>)</span>
    <div class="tool-result"></div>`;
  row.addEventListener('click', () => row.classList.toggle('open'));
  els.msgList.appendChild(row);
  autoScroll();
  return row;
}

function addStatusRow(text) {
  const row = document.createElement('div');
  row.className = 'status-row';
  row.innerHTML = `<span class="status-spinner"></span><span>${escapeHtml(text)}</span>`;
  els.msgList.appendChild(row);
  autoScroll();
  return row;
}

function addApprovalCard(request) {
  const card = document.createElement('div');
  card.className = 'gate-card';
  card.innerHTML = `
    <div class="gate-title">
      <svg class="icon warn" viewBox="0 0 24 24"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
      需要你的批准:${escapeHtml(request.toolName)}
    </div>
    <div class="gate-meta">
      目标文件:<b>${escapeHtml(request.filePath)}</b><br>
      ${escapeHtml(request.summary)}
    </div>
    ${request.diffPreview ? `<div class="gate-diff">${escapeHtml(request.diffPreview)}</div>` : ''}
    <div class="gate-actions">
      <button class="btn primary" data-act="approve">批准执行</button>
      <button class="btn" data-act="reject">拒绝</button>
    </div>`;
  const decide = async (approved) => {
    card.querySelectorAll('.btn').forEach((b) => { b.disabled = true; });
    try {
      await fetch(`/api/session/${state.sessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, approved }),
      });
      const note = document.createElement('div');
      note.className = 'status-row';
      note.innerHTML = `<span>${approved ? '✅ 已批准' : '🚫 已拒绝'}</span>`;
      card.replaceWith(note);
    } catch (err) {
      toast('提交审批结果失败: ' + err.message);
    }
  };
  card.querySelector('[data-act="approve"]').addEventListener('click', () => decide(true));
  card.querySelector('[data-act="reject"]').addEventListener('click', () => decide(false));
  els.msgList.appendChild(card);
  autoScroll();
}

function addQuestionCard(request) {
  const card = document.createElement('div');
  card.className = 'gate-card question';
  const questions = request.questions || [];

  const questionsHtml = questions.map((q, qi) => {
    const optionsHtml = (q.options || []).map((opt) => `
      <button class="q-option" data-q="${qi}" data-label="${escapeHtml(opt.label)}">
        ${escapeHtml(opt.label)}
        ${opt.description ? `<span class="q-desc">${escapeHtml(opt.description)}</span>` : ''}
      </button>`).join('');

    return `
      <div class="gate-title">
        <svg class="icon warn" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01"/></svg>
        ${q.header ? escapeHtml(q.header) + ': ' : ''}${escapeHtml(q.question)}
      </div>
      ${optionsHtml ? `<div class="q-options-wrap">${optionsHtml}</div>` : ''}
    `;
  }).join('<hr style="border:none;border-top:1px solid #e8e8e8;margin:10px 0">');

  card.innerHTML = `
    ${questionsHtml}
    <div class="q-input-row">
      <input type="text" class="q-input" placeholder="输入回复内容或补充说明 (按 Enter 提交)..." />
      <button class="btn primary q-submit-btn">提交回复</button>
    </div>
  `;

  const submitAnswer = async (answer) => {
    const text = String(answer || '').trim();
    if (!text) {
      toast('请输入回复内容');
      return;
    }
    card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    try {
      await fetch(`/api/session/${state.sessionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, answer: text }),
      });
      const note = document.createElement('div');
      note.className = 'status-row';
      note.innerHTML = `<span>✅ 已回复: ${escapeHtml(text)}</span>`;
      card.replaceWith(note);
    } catch (err) {
      toast('提交回复失败: ' + err.message);
    }
  };

  // 选项快捷点击
  card.querySelectorAll('.q-option').forEach((btn) => {
    btn.addEventListener('click', () => submitAnswer(btn.dataset.label));
  });

  // 自定义输入框提交
  const inputEl = card.querySelector('.q-input');
  const submitBtn = card.querySelector('.q-submit-btn');
  if (inputEl && submitBtn) {
    submitBtn.addEventListener('click', () => submitAnswer(inputEl.value));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitAnswer(inputEl.value);
      }
    });
    setTimeout(() => inputEl.focus(), 150);
  }

  els.msgList.appendChild(card);
  autoScroll();
}

// ---------------------------------------------------------------------------
// 消息发送与 SSE 流式处理
// ---------------------------------------------------------------------------
let currentRun = null;

function ensureSession() {
  if (state.sessionId) return Promise.resolve(state.sessionId);
  return fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
    .then((r) => r.json())
    .then((data) => {
      state.sessionId = data.sessionId;
      els.chatSessionTitle.textContent = data.title || '排障会话';
      return state.sessionId;
    });
}

function setInputEnabled(enabled) {
  state.busy = !enabled;
  els.input.disabled = !enabled;
  autosizeInput();

  if (els.chatStatusDot) {
    els.chatStatusDot.classList.toggle('busy', !enabled);
  }
  if (els.chatLiveBadge) {
    els.chatLiveBadge.hidden = enabled;
  }
  if (els.modelStatusIndicator && els.modelStatusText) {
    if (!enabled) {
      els.modelStatusIndicator.className = 'status-spinner';
      els.modelStatusText.textContent = '排障全链路执行中…';
    } else {
      updateHealthUI(currentServerHealth);
    }
  }
}

async function sendMessage(text) {
  const currentAttachments = [...state.attachments];
  const hasText = Boolean(text.trim());
  const hasAttachments = currentAttachments.length > 0;

  if (state.busy || (!hasText && !hasAttachments)) return;

  // 切换为聊天界面
  els.welcome.hidden = true;
  els.chat.hidden = false;

  // 组装用户界面展示与发送数据
  addUserMessage(text, currentAttachments);

  // 清空输入框与附件
  els.input.value = '';
  state.attachments = [];
  renderAttachments();
  autosizeInput();
  setInputEnabled(false);

  currentRun = {
    bubble: null,
    mdRaw: '',
    thinkingEl: null,
    thinkingRaw: '',
    statusEl: addStatusRow('正在分析排障需求…'),
    toolRows: new Map(),
    streamEnded: false,
  };

  try {
    const sessionId = await ensureSession();

    // 组装发给后端的数据: 如果有图片或文本附件，构造成 MessageContentPart[]
    let requestBody = {};
    const images = currentAttachments.filter((a) => a.isImage);
    const textFiles = currentAttachments.filter((a) => !a.isImage);

    let fullText = text;
    if (textFiles.length > 0) {
      for (const tf of textFiles) {
        fullText += `\n\n[附件文件: ${tf.name}]\n\`\`\`\n${tf.textContent || ''}\n\`\`\``;
      }
    }

    if (images.length > 0) {
      const parts = [];
      parts.push({ type: 'text', text: fullText || '请根据附件截图分析异常并定位代码位置：' });
      for (const img of images) {
        parts.push({
          type: 'image_url',
          image_url: { url: img.dataUrl, detail: 'high' },
        });
      }
      requestBody = { parts };
    } else {
      requestBody = { message: fullText };
    }

    const resp = await fetch(`/api/session/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    await consumeSse(resp, handleEvent);
    // 更新会话标题与列表
    await loadSessions();
  } catch (err) {
    appendAssistantText(`\n\n❌ **排障调用异常**: ${err.message}`);
  } finally {
    await finishRun();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 从服务端会话历史提取最后一条带文本内容的助手消息
function extractLastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && m.content.trim()) return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.find((p) => p.type === 'text');
      if (t && t.text && t.text.trim()) return t.text;
    }
  }
  return '';
}

// 断流对账：SSE 中断后轮询服务端会话状态，等后端任务完成后把最终答案补全到界面
async function reconcileFinalAnswer(maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`/api/session/${state.sessionId}`);
      if (resp.ok) {
        const data = await resp.json();
        const finalText = extractLastAssistantText(data.messages || []);
        if (!data.busy && finalText) {
          if (finalText.length > (currentRun.mdRaw || '').length) {
            appendAssistantText(finalText, true);
          }
          return true;
        }
      }
    } catch { /* 网络仍不通则继续等待下一轮 */ }
    await sleep(3000);
  }
  return false;
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
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) {
            try { onEvent(JSON.parse(payload)); } catch { /* 忽略坏帧 */ }
          }
        }
      }
    }
  }
}

function appendAssistantText(chunk, isFullReplace = false) {
  if (!currentRun) return;
  if (!currentRun.bubble) {
    currentRun.bubble = addAssistantBubble();
  }
  if (isFullReplace) {
    currentRun.mdRaw = chunk;
  } else {
    currentRun.mdRaw += chunk;
  }
  currentRun.bubble.innerHTML = renderMarkdown(currentRun.mdRaw);
  autoScroll();
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'reasoning_chunk':
      if (!currentRun.thinkingEl) currentRun.thinkingEl = addThinkingBlock();
      currentRun.thinkingRaw += ev.chunk;
      currentRun.thinkingEl.textContent = currentRun.thinkingRaw;
      currentRun.thinkingEl.scrollTop = currentRun.thinkingEl.scrollHeight;
      currentRun.statusEl.querySelector('span:last-child').textContent = '深度推理排障中…';
      break;

    case 'content_chunk':
      if (currentRun.statusEl && currentRun.statusEl.parentNode) currentRun.statusEl.remove();
      appendAssistantText(ev.chunk);
      break;

    case 'tool_call_start': {
      if (currentRun.statusEl && currentRun.statusEl.parentNode) currentRun.statusEl.remove();
      // 工具开始执行时，断开之前的文本卡片绑定，保证后续结论文本始终渲染在工具卡片下方
      currentRun.bubble = null;
      currentRun.mdRaw = '';
      currentRun.thinkingEl = null;
      currentRun.thinkingRaw = '';
      currentRun.statusEl = addStatusRow(`正在执行工具: ${ev.toolCall.name} …`);
      const row = addToolRow(ev.toolCall);
      currentRun.toolRows.set(ev.toolCall.id, row);
      break;
    }

    case 'tool_call_result': {
      const row = currentRun.toolRows.get(ev.toolCallId);
      if (row) {
        row.classList.remove('running');
        const resultText = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result, null, 2);
        row.querySelector('.tool-result').textContent = resultText || '(已完成)';
        if (ev.isError) {
          row.classList.add('err');
          row.querySelector('.tool-head').innerHTML = `❌ ${row.querySelector('.tool-head').innerHTML}`;
        } else {
          row.querySelector('.tool-head').innerHTML = `✅ ${row.querySelector('.tool-head').innerHTML}`;
        }
      }
      break;
    }

    case 'approval_requested':
      if (currentRun.statusEl.parentNode) currentRun.statusEl.remove();
      addApprovalCard(ev.request);
      break;

    case 'question_requested':
      if (currentRun.statusEl.parentNode) currentRun.statusEl.remove();
      addQuestionCard(ev.request);
      break;

    case 'error': {
      if (currentRun.statusEl.parentNode) currentRun.statusEl.remove();
      appendAssistantText(`\n\n❌ **${ev.error}**`);
      break;
    }

    case 'done':
    case 'stream_end':
      if (currentRun) currentRun.streamEnded = true;
      break;
  }
}

async function finishRun() {
  if (currentRun) {
    // SSE 流未正常结束(连接中断)时，向服务端对账补全最终答案
    if (!currentRun.streamEnded && state.sessionId) {
      const notice = addStatusRow('连接中断，正在从服务器同步完整排障结果…');
      const ok = await reconcileFinalAnswer();
      notice.remove();
      if (!ok) {
        appendAssistantText('\n\n⚠️ **与服务器连接中断，后台仍在处理中。请稍后刷新页面或在会话列表重新进入本会话查看完整结论。**');
      }
    } else if (state.sessionId) {
      // 正常结束也静默对账一次，确保界面与服务端最终状态一致
      await reconcileFinalAnswer(10000);
    }
    if (currentRun.statusEl && currentRun.statusEl.parentNode) currentRun.statusEl.remove();
    if (currentRun.bubble && !currentRun.mdRaw.trim() && !currentRun.bubble.hasChildNodes()) {
      currentRun.bubble.innerHTML = '<p style="color:#999">(排障执行完毕)</p>';
    }
  }
  currentRun = null;
  setInputEnabled(true);
  els.input.focus();
}

// ---------------------------------------------------------------------------
// 输入框事件与键盘监听 (支持 Enter 发送, Shift+Enter 换行)
// ---------------------------------------------------------------------------
let isComposing = false;

function autosizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
  const hasContent = els.input.value.trim().length > 0 || state.attachments.length > 0;
  els.sendBtn.disabled = state.busy || !hasContent;
}

els.input.addEventListener('compositionstart', () => {
  isComposing = true;
});

els.input.addEventListener('compositionend', () => {
  isComposing = false;
});

els.input.addEventListener('input', autosizeInput);

els.input.addEventListener('keydown', (e) => {
  // 正在输入法拼音合成阶段(keyCode 229 或 isComposing 为 true)，不触发发送
  if (e.isComposing || isComposing || e.keyCode === 229) {
    return;
  }

  // 单按 Enter 键发送消息
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    const text = els.input.value;
    const hasContent = text.trim().length > 0 || state.attachments.length > 0;
    if (hasContent && !state.busy) {
      sendMessage(text);
    }
  }
});

els.sendBtn.addEventListener('click', () => {
  if (!state.busy) {
    sendMessage(els.input.value);
  }
});

els.newChatBtn.addEventListener('click', startNewSession);
els.newChatTopBtn.addEventListener('click', startNewSession);

window.toggleSidebar = function () {
  const sb = document.getElementById('sidebar');
  sb.style.display = sb.style.display === 'none' ? 'flex' : 'none';
};

window.showHelpModal = function () {
  els.helpModal.hidden = false;
};

window.closeHelpModal = function () {
  els.helpModal.hidden = true;
};

// ---------------------------------------------------------------------------
// 右下角错误反馈逻辑
// ---------------------------------------------------------------------------
let selectedFeedbackType = '排障结论错误';

window.openFeedbackModal = function () {
  const modal = $('feedbackModal');
  const contextTip = $('feedbackContextTip');
  const sessionMsgCount = els.msgList.children.length;

  if (state.sessionId && sessionMsgCount > 0) {
    contextTip.textContent = `将自动附带当前会话（包含约 ${sessionMsgCount} 条交互与工具证据），方便研发精准复现。`;
  } else {
    contextTip.textContent = '当前未处于具体会话中，将仅上报反馈描述与客服专员身份。';
  }

  modal.hidden = false;
  $('feedbackText').value = '';
  $('feedbackText').focus();
};

window.closeFeedbackModal = function () {
  $('feedbackModal').hidden = true;
};

// 绑定标签切换
document.querySelectorAll('.type-tag').forEach((tag) => {
  tag.addEventListener('click', () => {
    document.querySelectorAll('.type-tag').forEach((t) => t.classList.remove('active'));
    tag.classList.add('active');
    selectedFeedbackType = tag.dataset.type;
  });
});

window.submitFeedback = async function () {
  const content = $('feedbackText').value.trim();
  const submitBtn = $('submitFeedbackBtn');
  if (!content) {
    toast('请先填写具体问题描述');
    $('feedbackText').focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '正在发送...';

  try {
    const resp = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        feedbackType: selectedFeedbackType,
        sessionId: state.sessionId || undefined,
      }),
    });

    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);

    closeFeedbackModal();
    toast('✅ 反馈已成功提交！感谢您的协助，研发人员将尽快核查。');
  } catch (err) {
    toast('提交失败: ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '发送反馈';
  }
};

// ---------------------------------------------------------------------------
// 启动运行
// ---------------------------------------------------------------------------
bootstrap().then(() => {
  autosizeInput();
  els.input.focus();
});
