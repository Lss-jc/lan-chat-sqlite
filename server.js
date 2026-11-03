'use strict';

/**
 * ============================================================================
 *  局域网简单聊天系统 · 后端服务（单文件，纯 JavaScript，零第三方依赖）
 * ============================================================================
 *
 *  用到的语言/技术：
 *    - JavaScript  ：本文件（Node.js 22 运行时）
 *    - HTML5/CSS3  ：根目录下的 index.html / style.css / app.js（index.html 即入口）
 *    - SQLite      ：数据存储，由 Node 22 内置的 node:sqlite 模块直接读写
 *
 *  为什么必须有个后端？
 *    SQLite 是"嵌入式数据库"：它本质上是磁盘上的一个 chat.db 文件 + 一个解析它的库，
 *    它没有监听任何网络端口，浏览器里的 JavaScript 也读不到本机文件系统。
 *    所以必须有人替浏览器去读写这个文件。本文件就是这个人：
 *        浏览器  --HTTP/JSON-->  server.js  --SQL-->  data/chat.db
 *
 *  启动方式：
 *      node server.js              # 默认端口 3001
 *      PORT=8080 node server.js    # 换端口（Windows cmd 用 set PORT=8080 && node server.js）
 *
 *  运维要点：
 *      数据库文件   ./data/chat.db      （首次启动自动建库建表；删掉它 = 清空一切数据）
 *      WAL 附属文件 ./data/chat.db-wal / chat.db-shm（SQLite 自动维护，备份时一起带上）
 *      备份         sqlite3 data/chat.db ".backup data/backup-2026.db"
 *      改前端资源   直接改根目录的 index.html / style.css / app.js，刷新即生效（服务无需重启）
 *      改后端逻辑   需要重启进程（Ctrl+C 后重新 node server.js）
 * ============================================================================
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ============================================================================
 *  第一部分：数据库连接（重点，逐行说明）
 * ============================================================================
 *
 *  这一部分是整个系统里最需要看懂的地方。SQLite 的使用可以概括成四步：
 *      1. 确保目录存在    2. 打开连接    3. 设置连接参数(PRAGMA)    4. 预编译语句
 */

const DATA_DIR = path.join(__dirname, 'data');   // 数据目录：和代码放一起，拷贝项目 = 拷贝数据
const DB_FILE = path.join(DATA_DIR, 'chat.db');  // 数据库文件路径（绝对路径最稳妥）

// ---------------------------------------------------------------------------
// 步骤 1：先保证"D文件夹"存在
// ---------------------------------------------------------------------------
// SQLite 能自动创建 .db 文件，但不会自动创建文件夹。
// 如果 data/ 目录不存在，打开时会直接抛 SQLITE_CANTOPEN，所以先建目录。
// recursive: true 表示"多级目录一起建，已存在也不报错"，可以放心重复调用。
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 步骤 2：打开数据库连接（文件不存在就自动创建）
// ---------------------------------------------------------------------------
// new DatabaseSync(路径) 会立刻打开/创建指定的 .db 文件。
//
// 关于 "Sync"：这是同步 API，每条 SQL 执行完才返回，没有 Promise / 回调。
// 对本项目完全够用——SQLite 是"进程内的一个文件"，一次查询是微秒级的，
// 根本不存在网络往返要等，用同步代码反而更简单、更不容易写错。
//
// 【关键】整个进程只打开这一个连接，全程复用。
//      不要写成"每个请求都 new 一个连接、查完再 close"：
//        - 打开连接要读文件头、校验、恢复 WAL，比查询本身还贵；
//        - 频繁开关会拖慢甚至偶发文件锁冲突。
//      一个连接 + 预编译语句，就是 SQLite 的最佳实践。
const db = new DatabaseSync(DB_FILE);

// ---------------------------------------------------------------------------
// 步骤 3：设置连接参数（PRAGMA）—— 决定这条连接"怎么工作"
// ---------------------------------------------------------------------------
// 这些参数非常关键，默认值并不适合聊天这种"多人同时读写"的场景：
//
//   journal_mode = WAL
//     WAL（预写日志）模式下，读操作和写操作互不阻塞：
//     一个人正在发消息（写），其他人仍然能正常刷新聊天记录（读）。
//     默认的 DELETE 模式下，一次写会锁住整个库，多人聊天时会出现明显卡顿。
//     注意：这是持久化设置，会记在 .db 文件里，只需设置一次，之后重启依然有效。
//
//   busy_timeout = 5000
//     万一真的撞上写锁（WAL 下写与写之间仍会互斥），最多排队等 5 秒，
//     而不是立刻抛 SQLITE_BUSY 让请求失败。
//
//   foreign_keys = ON
//     SQLite 默认"不强制"外键约束，而且这个开关是"每个连接"独立的，
//     所以必须在每次打开连接后手动打开；否则 messages.to_id 可以指向不存在的用户。
//
//   synchronous = NORMAL
//     WAL 模式下的推荐档位：写入更快，断电最多丢失最后几十毫秒的数据，
//     对聊天记录来说这个取舍是合理的。
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
`);

// ---------------------------------------------------------------------------
// 步骤 4：建表（IF NOT EXISTS，所以每次启动都可以放心执行）
// ---------------------------------------------------------------------------
// 三张表，职责单一：
//   users     账号表：用户名唯一，密码只存"哈希 + 盐"，绝不存明文
//   sessions  会话表：登录成功后发一个随机 token 给浏览器，服务端靠它认人
//   messages  消息表：谁发给谁、内容、时间
//
// 时间字段统一用"毫秒时间戳 INTEGER"（Date.now()），比字符串好排序、好比较。
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- 索引：按"会话双方 + id 递增"取新消息，是最高频的查询，必须建索引
  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id, id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// 顺手清掉已过期的登录凭证，避免 sessions 表无限增长（每次启动清一次即可）
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

/* ---------------------------------------------------------------------------
 *  预编译语句（Prepared Statement）
 * ---------------------------------------------------------------------------
 *  db.prepare(sql) 把 SQL 编译一次，得到语句对象，之后反复复用。
 *
 *  两个好处：
 *    1) 防 SQL 注入：SQL 的"结构"和"数据"彻底分离。用户输入只能填进 ? 的坑位，
 *       永远是"值"，永远变不成"语句"。绝对不要用字符串拼接 SQL，
 *       例如 `... WHERE username='${name}'` 就是典型漏洞写法。
 *    2) 性能：省去每次重新解析/编译 SQL 的开销。
 *
 *  用法：
 *    .run(...)  执行写操作（INSERT/UPDATE/DELETE），返回 { changes, lastInsertRowid }
 *    .get(...)  取第一行，没有则 undefined
 *    .all(...)  取全部行，返回数组
 *  参数用 ? 按顺序传，或用具名参数 { id: 1 } 配 :id。
 * ------------------------------------------------------------------------- */

const stmt = {
  // ---- 账号 ----
  insertUser: db.prepare(
    'INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)'
  ),
  findUserByName: db.prepare(
    'SELECT id, username, password_hash, salt FROM users WHERE username = ?'
  ),
  findUserById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  listUsers: db.prepare(
    'SELECT id, username, created_at AS createdAt FROM users ORDER BY id ASC'
  ),

  // ---- 会话（登录态）----
  insertSession: db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ),
  // 一条 SQL 同时完成"校验 token 未过期"和"取出用户信息"，避免两次查询
  sessionUser: db.prepare(`
    SELECT u.id, u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?
  `),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),

  // ---- 消息 ----
  insertMessage: db.prepare(
    'INSERT INTO messages (from_id, to_id, content, created_at) VALUES (?, ?, ?, ?)'
  ),
  // 取"我和对方"之间的消息；id > ? 用于只拉新消息（前端轮询增量更新）
  listMessages: db.prepare(`
    SELECT id, from_id AS fromId, to_id AS toId, content, created_at AS createdAt
      FROM messages
     WHERE id > ?
       AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
     ORDER BY id ASC
     LIMIT 500
  `),
  getMessageById: db.prepare(`
    SELECT id, from_id AS fromId, to_id AS toId, content, created_at AS createdAt
      FROM messages WHERE id = ?
  `),
};

/* ============================================================================
 *  第二部分：密码与登录态
 * ============================================================================ */

// scrypt 是 Node 内置的密钥派生函数：故意设计得又慢又吃内存，
// 即使数据库被拖走，攻击者拿哈希去暴力破解也极其昂贵。
// 每个用户配一个独立的随机"盐"（salt），保证相同密码在库里也是不同的哈希。
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHex) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  // timingSafeEqual：定长时间比较，避免通过响应时间差猜密码（计时攻击）
  return crypto.timingSafeEqual(actual, expected);
}

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 登录有效期 7 天

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex'); // 64 位十六进制随机串，猜不出来
  const now = Date.now();
  stmt.insertSession.run(token, userId, now, now + SESSION_TTL);
  return token;
}

// 从请求头 Authorization: Bearer <token> 里识别当前用户；识别不出返回 null
function currentUser(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  return stmt.sessionUser.get(token, Date.now()) || null;
}

/* ============================================================================
 *  第三部分：HTTP 小工具
 * ============================================================================ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', // 接口数据绝不缓存，否则会看到"过期的消息"
  });
  res.end(body);
}

// 读取并解析 JSON 请求体（带大小上限，防止有人一次 POST 几个 G 把内存打爆）
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    // 注意：先把原始字节收集成 Buffer，最后再统一转成字符串。
    // 如果边收边拼接字符串（raw += chunk），一个中文字符正好被拆在两个 TCP 包里时
    // 就会被解成乱码（U+FFFD），中文用户名/消息就会出错。
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });

    req.on('error', reject);
  });
}

/* ============================================================================
 *  第四部分：接口路由
 * ============================================================================
 *  POST /api/register   注册（成功即自动登录）
 *  POST /api/login      登录
 *  POST /api/logout     退出
 *  GET  /api/me         当前登录用户
 *  GET  /api/users      所有账号列表
 *  GET  /api/messages   某段对话的消息（?peerId=2&after=0）
 *  POST /api/messages   发消息 { toId, content }
 * ============================================================================ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // ------------------------- 注册 -------------------------
  if (p === '/api/register' && method === 'POST') {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    // 用户名：2-20 位，中文/字母/数字/下划线/短横线（\w = 字母数字下划线）
    if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(username)) {
      return sendJson(res, 400, { ok: false, error: '用户名需 2-20 位（中文、字母、数字、下划线）' });
    }
    if (password.length < 6 || password.length > 64) {
      return sendJson(res, 400, { ok: false, error: '密码长度需 6-64 位' });
    }
    if (stmt.findUserByName.get(username)) {
      return sendJson(res, 409, { ok: false, error: '该用户名已被注册' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const info = stmt.insertUser.run(username, hashPassword(password, salt), salt, Date.now());
    const user = { id: Number(info.lastInsertRowid), username };
    const token = createSession(user.id);
    console.log(`[注册] ${username} (id=${user.id})`);
    return sendJson(res, 200, { ok: true, token, user });
  }

  // ------------------------- 登录 -------------------------
  if (p === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const row = stmt.findUserByName.get(username);
    // 用户不存在和密码错误返回同一句话，不给攻击者"探测用户名是否存在"的线索
    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      return sendJson(res, 401, { ok: false, error: '用户名或密码错误' });
    }
    const user = { id: row.id, username: row.username };
    const token = createSession(user.id);
    console.log(`[登录] ${user.username} (id=${user.id})`);
    return sendJson(res, 200, { ok: true, token, user });
  }

  // 下面的接口都需要登录，先统一校验
  const me = currentUser(req);
  if (!me) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });

  if (p === '/api/logout' && method === 'POST') {
    const auth = req.headers['authorization'] || '';
    stmt.deleteSession.run(auth.slice(7).trim());
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { ok: true, user: me });
  }

  // ------------------------- 账号列表 -------------------------
  if (p === '/api/users' && method === 'GET') {
    return sendJson(res, 200, { ok: true, users: stmt.listUsers.all() });
  }

  // ------------------------- 拉取消息 -------------------------
  if (p === '/api/messages' && method === 'GET') {
    const peerId = Number(url.searchParams.get('peerId') || 0);
    const after = Number(url.searchParams.get('after') || 0);
    if (!peerId) return sendJson(res, 400, { ok: false, error: '缺少 peerId' });
    if (!stmt.findUserById.get(peerId)) {
      return sendJson(res, 404, { ok: false, error: '对方账号不存在' });
    }
    // 参数顺序对应 SQL 里的 5 个 ?：after、我→他、他→我
    const messages = stmt.listMessages.all(after, me.id, peerId, peerId, me.id);
    return sendJson(res, 200, { ok: true, messages });
  }

  // ------------------------- 发送消息 -------------------------
  if (p === '/api/messages' && method === 'POST') {
    const body = await readJsonBody(req);
    const toId = Number(body.toId || 0);
    const content = String(body.content || '').trim();

    if (!toId) return sendJson(res, 400, { ok: false, error: '缺少 toId' });
    if (!content) return sendJson(res, 400, { ok: false, error: '消息不能为空' });
    if (content.length > 2000) return sendJson(res, 400, { ok: false, error: '单条消息最多 2000 字' });
    if (toId === me.id) return sendJson(res, 400, { ok: false, error: '不能给自己发消息' });
    if (!stmt.findUserById.get(toId)) {
      return sendJson(res, 404, { ok: false, error: '对方账号不存在' });
    }

    const info = stmt.insertMessage.run(me.id, toId, content, Date.now());
    const saved = stmt.getMessageById.get(Number(info.lastInsertRowid));
    return sendJson(res, 200, { ok: true, message: saved });
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

/* ============================================================================
 *  第五部分：静态文件（HTML / CSS / JS）
 * ============================================================================ */

// 静态文件就放在项目根目录（index.html 在最外层当入口），
// 这样同一份文件既能被本地服务读取，也能原样上传到静态托管（Surge 等），
// 线上访问根路径 / 直接就是 index.html。
const PUBLIC_DIR = __dirname;

// 白名单：只有这三个前端文件允许被下载。
// 因为静态目录 = 项目根目录，如果不加限制，别人访问 /server.js 或 /data/chat.db
// 就能把后端源码和整个数据库拖走。
const STATIC_FILES = new Set(['index.html', 'style.css', 'app.js']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  // "/" 默认打开 index.html
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  if (!STATIC_FILES.has(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  const filePath = path.join(PUBLIC_DIR, rel);

  // 安全：防止 ../../ 之类的路径穿越，把服务器上的任意文件读出去
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      // no-cache：改完前端文件刷新生效，运维时不用去猜浏览器缓存
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

/* ============================================================================
 *  第六部分：启动服务（监听 0.0.0.0 才能被局域网访问）
 * ============================================================================ */

const PORT = Number(process.env.PORT) || 3001; // 3000 常被别的开发工具占用，这里用 3001
const HOST = '0.0.0.0'; // 监听所有网卡；若改成 127.0.0.1 就只有本机能访问

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error('[请求异常]', req.method, url.pathname, err.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用。换一个端口重试，例如：\n  PORT=3001 node server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  聊天服务已启动',
    '  ------------------------------------------------------------',
    `  数据库文件 : ${DB_FILE}`,
    `  本机访问   : http://localhost:${PORT}`,
  ];
  // 列出本机的局域网 IP，直接把地址发给同一 WiFi 下的同学/同事即可
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        lines.push(`  局域网访问 : http://${a.address}:${PORT}   (${name})`);
      }
    }
  }
  lines.push(
    '  ------------------------------------------------------------',
    '  若别人打不开：检查 Windows 防火墙是否放行了 Node.js / 该端口',
    '  停止服务：Ctrl + C',
    ''
  );
  console.log(lines.join('\n'));
});

/* ============================================================================
 *  第七部分：优雅退出（把 SQLite 干净地关掉）
 * ============================================================================
 *  db.close() 不只是关文件句柄：WAL 模式下它会把 -wal 日志里的内容合并回主库
 *  （checkpoint）。如果进程直接被强杀，数据不会丢，但下次启动要多做一次恢复。
 *  所以 Ctrl+C 时主动关一次是良好的运维习惯。
 * ============================================================================ */

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  server.close(() => {
    db.close();
    console.log('数据库已安全关闭，再见。');
    process.exit(0);
  });
  // 兜底：1 秒内没关完就强制退出，避免有个别 keep-alive 连接把进程挂住
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl + C
process.on('SIGTERM', () => shutdown('SIGTERM')); // 任务管理器 / 容器停止
