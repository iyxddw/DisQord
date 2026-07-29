# DisQord

DisQord 是一个自托管的 QQ ↔ Discord 消息互通项目。QQ、Discord 和中央控制端是三个固定程序，
可以分别运行在不同服务器上；两个客户端只主动连接中央端，不直接连接彼此。

项目面向个人或小规模群组使用，不依赖 MySQL、PostgreSQL、Redis，也不需要 Docker。中央端把
配置和运行状态保存到一个 JSON 文件；客户端身份与重试队列保存在各自的 `data` 目录中。

## 功能

- QQ 端使用 NapCat / OneBot 11，Discord 端使用 Discord Bot Gateway。
- 中央 Web 面板管理客户端、聊天会话、转发蓝图、大模型、提示词、人工审核和日志。
- 通过向目标群或频道发送验证码来验证聊天会话；更改群或频道需要重新验证。
- 使用蓝图连接任意已验证会话，支持单向或双向转发，以及多个蓝图同时运行。
- 中文和英文自动翻译，审核与翻译可以使用不同的 OpenAI Chat Completions 兼容模型。
- 可单独配置识图审核模型；图片无法审核时可以拦截、拦截并发送占位消息，或直接通过。
- QQ 目标卡片使用中文界面，Discord 目标卡片使用英文界面。
- 所有转发结果都是渲染后的 PNG 图片，包含头像、昵称、译文、半透明原文和回复预览。
- 支持文字、图片和图文混合消息；其余类型显示“不支持的消息”。
- 支持 Discord 原生回复、QQ 回复、QQ 群成员昵称解析和 `@昵称`。
- 节点掉线后自动重连，本地队列负责失败重试，中央端负责去重和回复映射。

## 架构

```text
NapCat ←→ QQ Node ─────┐
                       │ WebSocket
                       ▼
                  Central Server ←→ Web 控制面板
                       ▲
                       │ WebSocket
Discord API ←→ Discord Node
```

中央服务器需要能被两个客户端访问。最简单的部署方式是给中央端开放一个高位 TCP 端口，例如
`18080`。公网明文 HTTP/WS 会暴露管理登录和节点流量；长期公网运行建议再配置 HTTPS/WSS。

## 系统要求

- Node.js `22.22.0` 以上、`25` 以下；推荐 Node.js 24。
- pnpm `10.14.0`。
- Linux 中央服务器需要中文和 Emoji 字体。
- QQ 服务器需要已登录的 NapCat。
- Discord 服务器需要 Discord Bot Token。

Debian / Ubuntu 中央服务器安装字体：

```bash
apt update
apt install -y fonts-noto-cjk fonts-noto-color-emoji
fc-cache -f
```

## 下载与构建

三台服务器都从同一个仓库安装。使用 GitHub 传输和更新代码是标准做法：

```bash
git clone https://github.com/iyxddw/DisQord.git
cd DisQord
pnpm install --frozen-lockfile
pnpm build
```

项目根目录的 `.npmrc` 已使用 npmmirror。若机器上没有 pnpm，可以使用 Node 自带的 Corepack：

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
```

所有启动命令都必须在项目根目录执行，否则程序可能找不到已经构建的网页文件。

## 从零启动

以下是“不使用 Docker、不使用 Caddy、不配置自启动”的最短流程。环境变量只在当前终端有效，
关闭终端前请使用 `screen`、`tmux` 或其他进程管理方式保持程序运行。

### 1. 中央服务器

中央端直接监听 `18080`：

```bash
cd ~/DisQord
mkdir -p data

export CENTRAL_HOST=0.0.0.0
export CENTRAL_PORT=18080
export CENTRAL_DATA_PATH=./data/central.json
export PAIRING_PEPPER="$(openssl rand -hex 48)"
export COOKIE_SECURE=false

pnpm --filter @disqord/central-server start
```

第一次生成的 `PAIRING_PEPPER` 必须长期保存。后续启动如果换成别的值，已登记客户端将无法继续
认证。建议把环境变量保存到仅 root 可读的文件，例如 `central.env`：

```bash
chmod 600 central.env
set -a
. ./central.env
set +a
pnpm --filter @disqord/central-server start
```

健康检查：

```bash
curl http://127.0.0.1:18080/api/health
```

返回 `{"status":"ok",...}` 后，在浏览器打开：

```text
http://中央服务器地址:18080
```

首次进入时创建管理员密码。`central.json` 中保存管理员数据、客户端、会话、蓝图、日志、提示词
以及明文大模型 API Key，不要提交到 Git 或公开发送。

### 2. Discord 客户端

在 Discord Developer Portal 创建应用和 Bot：

1. 打开 **Message Content Intent**。
2. 邀请 Bot 加入服务器。
3. 至少授予 View Channel、Read Message History、Send Messages 和 Attach Files。
4. 复制 Bot Token。

如果 Discord Node 与 Central 在同一台机器，可使用 `127.0.0.1`：

```bash
cd ~/DisQord
mkdir -p data

export CENTRAL_WSS_URL=ws://127.0.0.1:18080/node
export ALLOW_INSECURE_CENTRAL=true
export DISCORD_BOT_TOKEN='你的 Bot Token'
export NODE_CONFIG_PATH=./data/discord-node.json
export NODE_QUEUE_PATH=./data/discord-queue.sqlite
export NODE_WEB_HOST=127.0.0.1
export NODE_WEB_PORT=8091
export NODE_WEB_TOKEN='至少16位的管理口令'
export NODE_WEB_ROOT=./apps/node-web/dist

pnpm --filter @disqord/discord-node start
```

如果 Discord Node 在另一台服务器，把 `127.0.0.1` 换成中央服务器公网 IP 或域名，并确保云
安全组、防火墙和路由允许访问 `18080`。

### 3. QQ 客户端

先在 NapCat WebUI 启用 OneBot 11 WebSocket 服务端：

- 监听地址：`127.0.0.1`
- 端口：`3001`
- Access Token：设置一个随机口令

然后在同一台 QQ 服务器启动 QQ Node：

```bash
cd ~/DisQord
mkdir -p data

export CENTRAL_WSS_URL=ws://中央服务器地址:18080/node
export ALLOW_INSECURE_CENTRAL=true
export NAPCAT_ONEBOT_WS_URL=ws://127.0.0.1:3001
export NAPCAT_ACCESS_TOKEN='NapCat 中设置的 Token'
export NODE_CONFIG_PATH=./data/qq-node.json
export NODE_QUEUE_PATH=./data/qq-queue.sqlite
export NODE_WEB_HOST=127.0.0.1
export NODE_WEB_PORT=8090
export NODE_WEB_TOKEN='至少16位的管理口令'
export NODE_WEB_ROOT=./apps/node-web/dist

pnpm --filter @disqord/qq-node start
```

不要把 NapCat 的 OneBot 端口开放到公网。中央服务器只需要访问 QQ Node 主动建立的连接。

## 控制面板配置顺序

### 客户端和聊天会话

1. 启动 QQ Node 或 Discord Node。
2. 打开中央面板的“客户端列表”，客户端会自动出现并显示“等待验证”。
3. Discord 填写服务器 ID 和频道 ID；QQ 填写群号。
4. 点击发送验证码，程序会向指定频道或群发送一条验证码。
5. 将验证码回填到中央面板，状态变为“已验证”。

验证后的会话会出现在“聊天会话”页面。要更换频道或群，请在“客户端列表”点击“更改会话”
并重新完成验证码流程。

### 转发蓝图

1. 打开“转发蓝图”，选择一个已验证会话。
2. 点击“来源”或“目标”创建节点。
3. 从来源节点右侧圆点拖到目标节点左侧圆点。
4. 填写蓝图名称并点击“保存并发布”。
5. 双向互通需要再建立反方向的连接。

删除节点有两种方法：

- 点击节点右侧的垃圾桶按钮。
- 选中节点后按 `Delete` 或 `Backspace`。

发布后的版本不会被原地覆盖。再次编辑并发布会创建新版本，旧版本保留归档。左侧“已保存蓝图”
可以切换运行状态、重新打开或删除整个蓝图。多个处于“运行中”的蓝图会同时处理消息。

### 大模型与审核

在“基础设置”填写：

- API 基础地址，例如 `https://api.deepseek.com/v1`
- API Key
- 翻译模型
- 文字审核模型
- 识图审核模型（可选）
- 超时、重试和并发数

图片没有可用来源或没有设置识图模型时，可以选择：

- **拦截**：不向目标端发送内容。
- **拦截并保留占位消息**：隐藏原图和原文，只发送“内容未通过审核”提示卡片。
- **直接通过**：跳过图片审核并继续转发。

“人工审核”保存需要管理员决定的任务。“高级模式”用于编辑并发布翻译和审核提示词。推荐提示词
和输出约束见 [`docs/PROMPTS.md`](docs/PROMPTS.md)。

## 消息渲染规则

- 发往 QQ 的卡片界面文字全部为中文。
- 发往 Discord 的卡片界面文字全部为英文。
- 翻译结果显示在正文，原文显示在下方半透明区域。
- 回复文字或回复图片显示在正文上方；平台无法提供历史预览时明确显示“无可用预览”。
- Emoji 依赖中央服务器的 `fonts-noto-color-emoji`，修改字体后需要重启 Central。
- 每张卡片保留短 Trace ID，可以在“运行日志”中定位处理过程。

## 节点诊断面板

节点面板默认只监听 `127.0.0.1`。从自己的电脑通过 SSH 隧道访问：

```bash
ssh -L 8090:127.0.0.1:8090 用户名@QQ服务器
```

浏览器打开 `http://127.0.0.1:8090`，使用 `NODE_WEB_TOKEN` 登录。Discord 节点如果使用
`8091`，隧道两端端口也相应改为 `8091`。

## 更新

在对应服务器执行：

```bash
cd ~/DisQord
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
```

然后停止并重新启动该服务器上的程序。只修改中央端功能时通常只需更新 Central；修改 NapCat
适配器时必须更新 QQ Node；修改 Discord 适配器时必须更新 Discord Node。

更新中央端前建议备份：

```bash
cp data/central.json "data/central-$(date +%F-%H%M%S).json"
```

## 常见问题

### 页面能打开，但客户端不在线

- 检查 `CENTRAL_WSS_URL` 是否以 `/node` 结尾。
- 使用明文 `ws://` 时必须设置 `ALLOW_INSECURE_CENTRAL=true`。
- 确认中央服务器端口已在云安全组和防火墙放行。
- 不要删除节点的 `node.json`，其中保存长期身份。

### QQ Node 连不上 NapCat

- NapCat 必须已经登录 QQ。
- 启用的是 WebSocket 服务端，不是反向 WebSocket 客户端。
- URL、端口和 Access Token 必须完全一致。
- NapCat 与 QQ Node 在同一台机器时使用 `ws://127.0.0.1:3001`。

### Discord 能上线但读不到消息正文

- 打开 Message Content Intent。
- 检查服务器和具体频道的权限覆盖。
- Bot 需要 View Channel 和 Read Message History。

### 卡片中文或 Emoji 显示方框

在中央服务器执行：

```bash
apt install -y fonts-noto-cjk fonts-noto-color-emoji
fc-cache -f
```

然后重启 Central。字体安装在 QQ 或 Discord 客户端服务器上不会影响卡片，因为 PNG 是中央端
生成的。

### `pnpm install` 忽略 esbuild 构建脚本

执行：

```bash
pnpm approve-builds
```

选择 `esbuild` 后重新运行 `pnpm install` 和 `pnpm build`。

更多排障和备份说明见 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)。更完整的 systemd、HTTPS/WSS
部署方案见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 开发

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

常用开发命令：

```bash
pnpm dev:central
pnpm dev:central-web
pnpm dev:qq
pnpm dev:discord
```

项目需求和安全边界见 [`PROJECT_REQUIREMENTS.md`](PROJECT_REQUIREMENTS.md)。
