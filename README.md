# DisQord

DisQord 是一个自托管的 QQ ↔ Discord 消息桥。它把 QQ 群和 Discord 频道接入同一个中央服务，支持双向转发、翻译、内容审核、回复映射和消息卡片渲染。

项目由三个固定角色组成：中央服务端、QQ 节点和 Discord 节点。节点只主动连接中央服务端，QQ 节点和 Discord 节点之间不直接通信。

> QQ 接入依赖 NapCat / OneBot 11，使用普通 QQ 账号时请自行评估账号风控和协议变动风险。

## 架构

```text
                         ┌────────────────────┐
                         │ Central Server     │
                         │ API + Web + 流程编排 │
                         └─────────┬──────────┘
                                   │ WebSocket
                    ┌──────────────┴──────────────┐
                    │                             │
             ┌──────▼──────┐               ┌──────▼────────┐
             │ QQ Node     │               │ Discord Node  │
             │ NapCat      │               │ Discord Bot   │
             └─────────────┘               └───────────────┘
```

| 组件           | 作用                                                                |
| -------------- | ------------------------------------------------------------------- |
| Central Server | 节点管理、会话验证、蓝图执行、翻译、审核、投递、日志和中央 Web 面板 |
| QQ Node        | 连接 NapCat，负责 QQ 消息收发、规范化和本地队列                     |
| Discord Node   | 连接 Discord Gateway，负责 Discord 消息收发、规范化和本地队列       |
| Node Web       | 查看节点连接、队列和诊断信息                                        |

## 功能

- QQ 群和 Discord 频道双向转发，也支持一对多、多对一路由。
- 在 Web 面板中用蓝图配置消息入口、翻译、审核、人工审核、固定文本和发送目标。
- 翻译和审核使用 OpenAI 兼容接口；审核按 0～1 的违规分数和阈值分流。
- 识别 QQ / Discord 原生回复，并把跨平台回复映射回另一端的原消息。
- 支持文本、图片和图文消息；不支持的消息类型会以提示卡片转发。
- Discord 自定义表情会获取原始图片，并按接近文字高度内嵌到卡片正文中；普通图片仍保持独立图片区块。
- QQ `[CQ:face,id=123]` 由 Discord 节点使用 `apps/discord-node/default-emojis/123.png` 本地渲染，正文和回复预览都会显示。
- 节点断线自动重连，中央端负责去重、投递确认和回复 ID 映射，节点本地保存失败重试队列。
- 中央运行日志和节点日志最多保留 `16,384` 条，采用追加写入并在需要时批量整理。
- 不依赖 MySQL、PostgreSQL、Redis 或 Docker；中央状态和节点数据写入各自的数据目录。

## 消息渲染和审核

### 文本消息

纯文本消息不会把头像图片反复传给中央端。中央端发送包含头像引用的渲染规格，引用格式是平台和用户代号；目标节点先查本地头像缓存，缓存未命中时向中央端请求一次头像，然后在本地合成最终 PNG 卡片。

### 含图片的消息

消息本身包含图片，或者回复引用中包含普通图片时，由中央端下载并合成卡片，再把最终 PNG 下发给目标节点。普通图片无法完成审核时会按失败处理，不会直接放行。

### 回复机器人卡片

如果被回复的是 DisQord 自己发送的卡片，中央端可以通过投递映射找到原始消息。这种情况下：

- 审核使用原始消息文本，不再把机器人生成的卡片图送给图片模型；
- 卡片中的“被回复消息”显示原始文本，而不是再次嵌入机器人卡片；
- 原始消息中如果还有真实图片，这些图片仍然按普通图片流程审核；
- 回复发送时使用目标平台的原生 reply，并指向另一端对应的原消息。

## 环境要求

- Node.js `>=22.22.0 <25`，推荐 Node.js 24。
- pnpm `10.14.0`。
- 使用项目自带启动脚本需要 PM2；使用 systemd 部署时不需要 PM2。
- QQ 节点：已登录的 NapCat，并启用 OneBot 11 WebSocket 服务端。
- Discord 节点：Discord Bot Token、Message Content Intent，以及读取和发送消息的权限。
- 实际发送卡片的 QQ / Discord 节点需要安装中文字体和彩色 Emoji 字体：

  ```bash
  sudo apt update
  sudo apt install -y fontconfig fonts-noto-cjk fonts-noto-color-emoji
  sudo fc-cache -f
  ```

## 安装和构建

```bash
git clone https://github.com/iyxddw/DisQord.git
cd DisQord

corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

如果机器已经安装对应版本的 pnpm，可以跳过 Corepack 步骤。

## 配置和启动

生产环境建议使用 `systemd + Caddy`，完整步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。快速测试或使用 PM2 时，项目根目录的启动脚本会读取三个环境文件：

```text
central.env    # Central Server
qq.env         # QQ Node
discord.env    # Discord Node
```

环境变量示例见 [`.env.example`](.env.example) 和 [`deploy/native/`](deploy/native/)。至少需要配置：

- Central：监听地址、数据路径、`PAIRING_PEPPER` 和 Cookie 安全选项；
- QQ Node：Central WebSocket 地址、NapCat OneBot 地址和 Access Token；
- Discord Node：Central WebSocket 地址和 Discord Bot Token。

不要把填入真实 Token、API Key 或 `PAIRING_PEPPER` 的环境文件提交到 Git。

构建完成并准备好环境文件后，可以分别启动：

```bash
bash start-central.sh
bash start-qq.sh
bash start-discord.sh
```

这些脚本使用 PM2，并会启动或重启对应进程。开发时也可以使用：

```bash
pnpm dev:central
pnpm dev:central-web
pnpm dev:qq
pnpm dev:discord
pnpm dev:node-web
```

## 第一次使用

1. 启动 Central Server，以及至少一个平台节点。
2. 打开中央 Web 面板，第一次进入时设置管理员密码。
3. 在“绑定会话”中选择节点上报的 QQ 群或 Discord 频道。
4. 发送验证码，并把验证码回填到面板完成验证。
5. 在“转发蓝图”中添加消息入口、处理模块和发送目标，然后保存并发布。
6. 双向转发需要为两个方向分别创建一条蓝图。

蓝图只能使用已经验证的会话。更换 QQ 群或 Discord 频道时，需要重新绑定并验证。

## 更新

交互式更新：

```bash
bash update.sh
```

菜单使用方向键移动、空格选择、回车确认。构建成功后会自动执行所选角色对应的启动脚本，重启对应的 PM2 进程。

也可以直接指定目标：

```bash
bash update.sh central --yes
bash update.sh qq --yes
bash update.sh discord --yes
bash update.sh all --yes --verify
```

常用选项：

```bash
bash update.sh qq --no-pull       # 不拉取远端，只构建当前工作区
bash update.sh central --no-restart
bash update.sh all --yes --verify # 更新后运行完整 typecheck 和 test
```

默认更新流程是：检查工作区 → 快进拉取当前分支 → 安装锁定依赖 → 构建选中角色 → 重启选中角色。检测到未提交的跟踪文件修改时会停止拉取，避免覆盖本地代码；需要先提交、暂存或使用 `--no-pull`。

## 开发

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

仓库采用 pnpm workspace，主要目录如下：

```text
apps/
  central-server/   中央服务端
  central-web/      中央 Web 面板
  qq-node/          QQ 节点
  discord-node/     Discord 节点
  node-web/         节点诊断面板
packages/
  adapter-*         平台适配器
  blueprint/        蓝图执行引擎
  card-renderer/    卡片渲染和媒体处理
  llm/              翻译与审核服务
  node-runtime/     节点运行时
  queue/            本地队列
  shared/           共享类型和协议
  transport/        节点通信和认证
```

## 文档

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)：systemd、Caddy、HTTPS/WSS 和三台服务器部署。
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)：日志、备份、恢复、回滚和故障排查。
- [`docs/PROMPTS.md`](docs/PROMPTS.md)：翻译和审核模块的提示词建议。
- [`PROJECT_REQUIREMENTS.md`](PROJECT_REQUIREMENTS.md)：项目范围、约束和实现要求。

## 许可

Apache License 2.0，见 [`LICENSE`](LICENSE)。
