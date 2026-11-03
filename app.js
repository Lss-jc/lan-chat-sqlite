/* ============================================================================
   局域网聊天室 · 前端逻辑
   ----------------------------------------------------------------------------
   与后端的所有交互都是同源的相对路径请求（/api/...），所以部署到哪台机器、
   用 3000 还是 8000 端口，前端代码一个字都不用改。

   消息刷新采用"轮询"：每 1.2 秒带 ?after=最后一条消息id 去问一次，
   只要返回新消息就追加。实现最简单，且只传增量，开销很小。
   ============================================================================ */

'use strict';

/* ---------------- 全局状态 ---------------- */
const state = {
  token: localStorage.getItem('chat_token') || '', // 记住登录态，刷新页面不用重新登录
  me: null,          // { id, username }
  users: [],         // 全部账号
  peerId: 0,         // 当前正在聊天的对象 id
  lastId: 0,         // 当前会话里已渲染的最大消息 id（增量拉取的游标）
  mode: 'login',     // 'login' | 'register'
  pollTimer: null,
  tick: 0,           // 轮询计数，用来降低"刷新账号列表"的频率
};

/* ---------------- DOM 引用 ---------------- */
const $ = (id) => document.getElementById(id);
const authView = $('authView');
const chatView = $('chatView');
const authForm = $('authForm');
const usernameInput = $('usernameInput');
const passwordInput = $('passwordInput');
const submitBtn = $('submitBtn');
const authMsg = $('authMsg');
const meName = $('meName');
const meAvatar = $('meAvatar');
const userList = $('userList');
const userCount = $('userCount');
const peerName = $('peerName');
const peerHint = $('peerHint');
const messageList = $('messageList');
const sendForm = $('sendForm');
const messageInput = $('messageInput');
const sendBtn = $('sendBtn');

/* ============================================================================
   一、请求封装
   ============================================================================ */

/**
 * 统一调用后端接口。
 * @param {string} path   例如 '/api/users'
 * @param {object} options { method, body }，body 会被自动转成 JSON
 */
async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };

  if (options.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  // 登录后每个请求都带上 token，后端靠它识别"我是谁"
  if (state.token) init.headers['Authorization'] = 'Bearer ' + state.token;

  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));

  // 401 = 没登录 / token 过期：直接回登录页，避免界面卡在"发不出消息"的状态
  if (res.status === 401 && path !== '/api/login') {
    handleLogout(true);
    throw new Error(data.error || '登录已过期，请重新登录');
  }
  return data;
}

/* ============================================================================
   二、登录 / 注册
   ============================================================================ */

// Tab 切换：只改按钮样式和提交按钮文案，表单本身复用
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    submitBtn.textContent = state.mode === 'login' ? '登录' : '注册并登录';
    authMsg.textContent = '';
    authMsg.classList.remove('ok');
  });
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return;

  submitBtn.disabled = true;
  authMsg.classList.remove('ok');
  authMsg.textContent = '请稍候...';

  try {
    const data = await api('/api/' + state.mode, {
      method: 'POST',
      body: { username, password },
    });

    if (!data.ok) {
      authMsg.textContent = data.error || '操作失败';
      return;
    }

    // 注册和登录成功都返回 token，直接进入聊天界面
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem('chat_token', data.token);
    passwordInput.value = '';
    await enterChat();
  } catch (err) {
    authMsg.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    if (state.me) authMsg.textContent = '';
  }
});

/* ============================================================================
   三、进入 / 退出聊天
   ============================================================================ */

async function enterChat() {
  authView.classList.add('hidden');
  chatView.classList.remove('hidden');

  meName.textContent = state.me.username;
  meAvatar.textContent = state.me.username.slice(0, 1);

  await refreshUsers();
  startPolling();
}

/**
 * @param {boolean} silent true 表示由 401 触发，不需要用户确认
 */
function handleLogout(silent) {
  if (!silent) {
    api('/api/logout', { method: 'POST' }).catch(() => {});
  }
  state.token = '';
  state.me = null;
  state.peerId = 0;
  state.lastId = 0;
  localStorage.removeItem('chat_token');
  stopPolling();

  chatView.classList.add('hidden');
  authView.classList.remove('hidden');
  messageList.innerHTML = '<p class="empty-tip" id="emptyTip">还没有选择聊天对象</p>';
  peerName.textContent = '选择一个账号开始聊天';
  peerHint.textContent = '点击左侧任意账号';
  messageInput.value = '';
  messageInput.disabled = true;
  sendBtn.disabled = true;
  authMsg.textContent = silent ? '登录已过期，请重新登录' : '';
}

$('logoutBtn').addEventListener('click', () => handleLogout(false));

/* ============================================================================
   四、账号列表
   ============================================================================ */

async function refreshUsers() {
  const data = await api('/api/users').catch(() => null);
  if (!data || !data.ok) return;

  state.users = data.users;
  userCount.textContent = data.users.length;

  userList.innerHTML = '';
  for (const user of data.users) {
    const isMe = user.id === state.me.id;

    const li = document.createElement('li');
    li.className = 'user-item' + (isMe ? ' is-me' : '') + (user.id === state.peerId ? ' active' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = user.username.slice(0, 1);

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = user.username; // 用 textContent，用户名里的 <> 等字符不会被当成 HTML
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'ID ' + user.id;
    info.append(name, meta);

    li.append(avatar, info);

    // 点自己不发消息，只做展示
    if (!isMe) li.addEventListener('click', () => selectPeer(user));
    userList.append(li);
  }
}

/* ============================================================================
   五、选择聊天对象 & 消息渲染
   ============================================================================ */

async function selectPeer(user) {
  if (state.peerId === user.id) return;

  state.peerId = user.id;
  state.lastId = 0;
  peerName.textContent = user.username;
  peerHint.textContent = 'ID ' + user.id + ' · 消息实时同步';

  // 高亮当前账号
  document.querySelectorAll('.user-item').forEach((el) => el.classList.remove('active'));
  [...userList.children].forEach((el, i) => {
    if (state.users[i] && state.users[i].id === user.id) el.classList.add('active');
  });

  messageList.innerHTML = '';
  messageInput.disabled = false;
  sendBtn.disabled = false;
  messageInput.focus();

  await loadMessages(0);
}

/** 拉取消息：after=0 取全部历史，after>0 只取新消息 */
async function loadMessages(after) {
  const data = await api(`/api/messages?peerId=${state.peerId}&after=${after}`).catch(() => null);
  if (!data || !data.ok) return;
  if (!data.messages.length) return;

  const nearBottom = isNearBottom();
  for (const m of data.messages) appendMessage(m);

  if (nearBottom) scrollToBottom();
}

function appendMessage(m) {
  const mine = m.fromId === state.me.id;

  const row = document.createElement('div');
  row.className = 'row ' + (mine ? 'mine' : 'peer');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.content; // 关键：textContent 天然防 XSS，别改成 innerHTML

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = formatTime(m.createdAt);

  row.append(bubble, time);
  messageList.append(row);

  if (m.id > state.lastId) state.lastId = m.id;
}

function isNearBottom() {
  // 用户往上翻看历史时，不要强行把他拉回底部
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
}

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

/** 时间戳 → "HH:mm" / "昨天 HH:mm" / "MM-DD HH:mm" */
function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const isSameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isSameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`;
}

/* ============================================================================
   六、发送消息
   ============================================================================ */

sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendMessage();
});

// Enter 发送，Shift+Enter 换行
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendForm.requestSubmit();
  }
});

// 输入框随内容自动长高，最多 140px（由 CSS max-height 控制）
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + 'px';
});

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !state.peerId) return;

  sendBtn.disabled = true;
  try {
    const data = await api('/api/messages', {
      method: 'POST',
      body: { toId: state.peerId, content },
    });
    if (!data.ok) {
      peerHint.textContent = data.error || '发送失败';
      return;
    }
    messageInput.value = '';
    messageInput.style.height = 'auto';
    appendMessage(data.message);
    scrollToBottom();
    messageInput.focus();
  } catch (err) {
    peerHint.textContent = err.message;
  } finally {
    sendBtn.disabled = false;
  }
}

/* ============================================================================
   七、轮询：让消息"接近实时"
   ============================================================================
   每 1.2 秒问一次服务器有没有新消息；每 5 次（约 6 秒）顺便刷新一次账号列表，
   这样别人刚注册的账号也能自动出现在列表里。
   真实生产系统一般换成 WebSocket，这里为了"最简单"用轮询。
   ============================================================================ */

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.me) return;
    state.tick++;

    if (state.peerId) {
      await loadMessages(state.lastId).catch(() => {});
    }
    if (state.tick % 5 === 0) {
      await refreshUsers().catch(() => {});
    }
  }, 1200);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ============================================================================
   八、启动：有本地 token 就直接续上登录态
   ============================================================================ */

(async function boot() {
  if (!state.token) return;
  const data = await api('/api/me').catch(() => null);
  if (data && data.ok) {
    state.me = data.user;
    await enterChat();
  } else {
    handleLogout(true);
  }
})();
