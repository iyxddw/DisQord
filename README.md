# DisQord

DisQord 是一个自托管的 QQ ↔ Discord 消息互通项目。QQ、Discord 和中央控制端是三个固定程序，
可以分别运行在不同服务器上；两个客户端只主动连接中央端，不直接连接彼此。

项目面向个人或小规模群组使用，不依赖 MySQL、PostgreSQL、Redis，也不需要 Docker。中央端把
配置和运行状态保存到一个 JSON 文件；客户端身份与重试队列保存在各自的 `data` 目录中。

## 功能

- QQ 端使用 NapCat / OneBot 11，Discord 端使用 Discord Bot Gateway。
- 中央 Web 面板管理客户端、聊天会话、转发蓝图、大模型和分级追踪日志。
- 通过向目标群或频道发送验证码来验证聊天会话；更改群或频道需要重新验证。
- 使用蓝图连接任意已验证会话，支持单向或双向转发，以及多个蓝图同时运行。
- 翻译、审核和固定文本都是可自由连线的蓝图模块，审核按 0～1 违规分数和阈值分流。
- 翻译模块支持“记忆模式”，可携带同一会话前 5 条文字和被回复消息原文。
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
mkdir -p data logs

export CENTRAL_HOST=0.0.0.0
export CENTRAL_PORT=18080
export CENTRAL_DATA_PATH=./data/central.json
export CENTRAL_AVATAR_CACHE_PATH=./data/avatar-cache
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
mkdir -p data logs

export CENTRAL_WSS_URL=ws://127.0.0.1:18080/node
export ALLOW_INSECURE_CENTRAL=true
export DISCORD_BOT_TOKEN='你的 Bot Token'
export NODE_CONFIG_PATH=./data/discord-node.json
export NODE_QUEUE_PATH=./data/discord-queue.json
export NODE_LOG_PATH=./logs/discord-node.jsonl
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
export NODE_QUEUE_PATH=./data/qq-queue.json
export NODE_LOG_PATH=./logs/qq-node.jsonl
export NODE_WEB_HOST=127.0.0.1
export NODE_WEB_PORT=8090
export NODE_WEB_TOKEN='至少16位的管理口令'
export NODE_WEB_ROOT=./apps/node-web/dist

pnpm --filter @disqord/qq-node start
```

不要把 NapCat 的 OneBot 端口开放到公网。中央服务器只需要访问 QQ Node 主动建立的连接。

节点队列现在以可读的 JSON 文件保存，客户端日志以 JSONL 写入 `~/DisQord/logs/`，也可以在节点控制
面板按等级和关键词查看。升级旧版本时，请把仍指向 `*.sqlite` 的 `NODE_QUEUE_PATH` 改成上面的
`*.json` 路径；旧队列文件不会自动迁移，建议先停掉节点并备份后再切换。若启动时发现旧文件内容
不是 JSON（例如曾经误创建的 `queue.sqlite`），节点会把它改名为带 `.invalid-时间戳` 的备份文件并
从空队列继续启动，不会因为队列损坏退出。

## 控制面板配置顺序

### 客户端和聊天会话

1. 启动 QQ Node 或 Discord Node。
2. 打开中央面板的“绑定会话”，客户端会自动出现并列出机器人可见的群或频道；这个页面只负责新增绑定，已绑定会话在“聊天会话”页面管理。
3. 选择目标会话。QQ 会自动显示群名，Discord 会自动显示服务器名和频道名。
4. 点击发送验证码，程序会向指定频道或群发送一条验证码。
5. 将验证码回填到中央面板，点击“完成验证”后等待按钮完成校验，成功后才会显示绑定成功。验证码过期时可点击“重新发送验证码”，不需要删除会话。

一个客户端可以绑定多个会话。验证后的会话会出现在“聊天会话”页面；悬停会话可添加备注或
删除。要更换频道或群，删除旧会话后在“绑定会话”重新完成验证码流程。

### 转发蓝图

1. 打开“转发蓝图”，选择一个已验证会话并添加“消息入口”。
2. 按需添加“翻译”“审核”“人工审核”和“固定文本”模块。
3. 再选择目标会话并添加“发送目标”。
4. 从左到右连接模块。审核和人工审核节点右侧上方是“通过”，下方是“拦截”；点击已有连线可删除。
5. 填写蓝图名称并点击“保存并发布”。双向互通需要建立两条独立流水线。

推荐的常规路径：

```text
消息入口 → 翻译 → 审核 ──通过──→ 人工审核 ──通过──→ 发送目标
                       └─拦截──→ 固定文本 → 发送目标
                                      人工审核 └─拦截──→ 固定文本 → 发送目标
```

审核模块的滑块表示允许的最高违规分数：模型分数小于或等于阈值时走“通过”，高于阈值时走
“拦截”。提示词直接填写在翻译或审核模块下方，不再使用单独的全局提示词页面。固定文本模块会
替换当前处理文本，适合输出“内容未通过审核”等提示。

翻译、审核和固定文本只修改流水线中的文字。每个发送目标都会自动重新读取消息入口收到的头像、
昵称、附件、时间和回复信息，再将流水线当前文字渲染成 PNG，无需额外添加图片合成节点。旧蓝图
中的图片合成节点仍然兼容。固定文本不会在半透明区域泄露原文字，
但原消息携带的图片附件仍会按“只处理文字”的规则保留。

手机或窄屏打开蓝图时会自动切换成纵向只读卡片，可以查看模块配置、当前连接、分支路径和运行状态，
但不能编辑、改线、发布或发送模拟消息。页面顶部会提示前往桌面端完成这些操作。新模块在桌面端添加时
会自动连接到当前流程末尾。

模拟输入运行时，节点先显示浅绿色运行底层；更亮的绿色附层会快速推进到 50%，之后每隔随机 0.5～2 秒
继续向前移动，并在接近 100% 时逐渐减速。只有当前节点真实完成时才显示 100%，随后立即熄灭当前节点，
并以 50% 的附层点亮实际选中的下一节点。模拟输入点击“发送”后也直接显示 50%。“保存并运行”和
“发布新版本”在请求期间会锁定并显示加载动画，避免重复提交。真实消息不会因为模拟间隔设置而增加延迟。
蓝图活动使用长轮询读取，页面保持打开时通常只会有一条等待中的活动请求，而不会持续高频刷新接口。

删除节点有两种方法：

- 点击节点右侧的垃圾桶按钮。
- 选中节点后按 `Delete` 或 `Backspace`。

点击一条已有连线会立即取消这条连接。人工审核节点会暂停该分支，并把消息放入“人工审核”页面；
管理员选择批准或拦截后，流水线从对应出口继续。“一键清除”会删除审核记录，仍在等待的消息不会
继续转发。

发布后的版本不会被原地覆盖。再次编辑并发布会创建新版本，旧版本保留归档。左侧“已保存蓝图”
可以切换运行状态、重新打开或删除整个蓝图。多个处于“运行中”的蓝图会同时处理消息。

### 大模型与审核

在“基础设置”填写：

- API 基础地址，例如 `https://api.deepseek.com/v1`
- API Key
- 翻译模型
- 文字审核模型
- 超时、重试和并发数

此外可以在基础设置中调整“蓝图模拟节点间隔”。它只影响模拟输入的逐节点播放速度，不会给真实消息
增加延迟。

基础设置只管理 API 连接和模型名称。所有生产提示词、记忆模式和审核阈值均保存在对应蓝图版本
中。推荐提示词和结构化输出约束见 [`docs/PROMPTS.md`](docs/PROMPTS.md)。

如果消息需要尽快到达，可以在基础设置打开“疾速模式”。它会关闭头像和附件下载、图片合成以及
客户端的 8/6/4/2 秒聚合窗口，中央仍然执行翻译和审核，但节点改为发送纯文本（保留发送者昵称）。
同一目标的发送槽位固定为每 5 秒一个，单条发送失败最多重试 4 次；不同目标可以并行处理。图片在疾速
模式下无法交给识图模型，审核会按“无法审核”处理并走拦截分支。关闭疾速模式后恢复 PNG 卡片和正常
批量聚合策略。

“运行日志”可以按设备、Debug、Info、Warn 和 Error 筛选，并记录入口消息、蓝图和节点、翻译原始
返回、审核原始评分、渲染结果、发送排队、平台发送成功与失败。选择 QQ 或 Discord 客户端时，中央服务
会通过加密节点通道只拉取 Warn 和 Error 日志；事件名称会显示为中文，日志不会记录 API Key。

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

如果为了节省时间采用筛选构建，中央端必须同时构建它依赖的共享包。命令中的 `...` 不能省略，
否则可能出现网页已经支持新蓝图节点、运行中的后端却仍使用旧枚举的情况：

```bash
pnpm --filter @disqord/central-server... build
pnpm --filter @disqord/central-web build
```

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
