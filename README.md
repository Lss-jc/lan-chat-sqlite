# 局域网聊天系统（SQLite + 原生 JS）

一个可以在局域网内多人使用的极简聊天系统：注册、登录、查看全部账号、点对点发消息。
账号、会话、消息全部持久化在本机 SQLite 数据库里，**零第三方依赖、零 npm install**。

## 技术栈

| 层次 | 实现 |
|---|---|
| 前端 | HTML5 + CSS3 + 原生 JavaScript（无框架） |
| 后端 | Node.js 22+（`node:http`，就是 JavaScript 运行时） |
| 数据库 | SQLite，通过 Node 内置 `node:sqlite` 读写 |
| 部署 | 本地局域网 / 静态托管（仅页面） |

> 为什么需要后端：SQLite 是嵌入式数据库，只有 `.db` 文件，不监听端口，
> 浏览器也无法直接读写本地文件。所以由 Node 进程做中间人：
> `浏览器 --HTTP/JSON--> server.js --SQL--> data/chat.db`

## 目录结构

```
.
├─ index.html      入口页面（登录 + 聊天界面）
├─ style.css       样式
├─ app.js          前端逻辑
├─ server.js       后端：HTTP 服务 + SQLite 读写（注释最详细的部分）
├─ start.bat       Windows 一键启动
├─ data/chat.db    数据库文件（首次启动自动生成，不入库）
└─ .surgeignore    Surge 发布排除清单
```

## 运行

要求：**Node.js 22 或更高**（`node:sqlite` 从 22.5 开始内置）。

```bash
node server.js              # 默认 3001 端口
PORT=8080 node server.js    # 换端口（Windows cmd: set PORT=8080 && node server.js）
```

Windows 下也可以直接双击 `start.bat`。

启动后终端会打印两个地址：

```
本机访问   : http://localhost:3001
局域网访问 : http://192.168.x.x:3001
```

同一 WiFi 下的手机/电脑打开「局域网访问」那个地址即可。若打不开，
检查 Windows 防火墙是否放行了 Node.js 或该端口。

## 接口

除注册、登录外，所有接口都需要请求头 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 注册，成功即自动登录 |
| POST | `/api/login` | 登录，返回 token（7 天有效） |
| POST | `/api/logout` | 退出，删除该 token |
| GET | `/api/me` | 当前登录用户 |
| GET | `/api/users` | 全部账号 |
| GET | `/api/messages?peerId=&after=` | 拉取与某人的消息，`after` 用于增量 |
| POST | `/api/messages` | 发送消息 `{ toId, content }` |

## 数据库

三张表，启动时自动建：

- `users`：`id / username / password_hash / salt / created_at`
- `sessions`：`token / user_id / created_at / expires_at`
- `messages`：`id / from_id / to_id / content / created_at`

要点：

- 密码用 `scrypt` + 每人独立随机盐做哈希，**数据库里没有明文密码**；
  登录校验用 `timingSafeEqual` 定长时间比较。
- 连接打开后设置 `journal_mode=WAL`（读写互不阻塞）、`busy_timeout=5000`、
  `foreign_keys=ON`（SQLite 默认不校验外键，且是每连接独立的开关）。
- 全程复用**一个连接** + 预编译语句，不做「每请求开一次、用完关掉」；
  参数一律走 `?` 占位，不做字符串拼接 SQL。
- 监听 `0.0.0.0` 才能被局域网访问（只监听 `127.0.0.1` 则仅本机可用）。

## 运维

| 场景 | 操作 |
|---|---|
| 备份（服务运行中也可） | `sqlite3 data/chat.db ".backup data/backup.db"` |
| 清空所有数据 | 停止服务 → 删除 `data/` 目录 → 重启 |
| 改前端 | 直接改 `index.html` / `style.css` / `app.js`，刷新浏览器生效 |
| 改后端 | 重启进程 |
| 停止 | `Ctrl + C`（会主动 `db.close()` 合并 WAL） |

静态目录就是项目根目录，为防源码与数据库被下载，`server.js` 里用白名单
只放行 `index.html`、`style.css`、`app.js` 三个文件。

## 部署到 Surge（纯静态，功能受限）

```bash
surge . lanchat-sqlite.surge.sh
```

`.surgeignore` 已排除 `server.js`、`start.bat`、`data/`，只上传前端三件套。

注意：Surge 只托管静态文件，**没有 Node 后端**，线上只能打开页面，
注册/登录/发消息都会失败（`/api/*` 不存在）。要线上可用，
需把 `server.js` 部署到能运行 Node 的平台（Render、Railway、自有服务器），
再把前端请求的接口地址改为该域名。
