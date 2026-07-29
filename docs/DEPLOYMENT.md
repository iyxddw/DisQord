# DisQord 部署与首次配置

本文按“三台服务器”描述。中央服务器需要公网域名；QQ 节点和 Discord 节点只需能主动访问
中央服务器，不必开放公网端口。若两种节点暂时部署在同一台机器，步骤相同，但生产环境仍建议隔离。

## 1. 准备

三台机器均安装：

- Git
- Docker Engine 与 Docker Compose 插件

中央服务器额外准备一个域名，例如 `central.example.com`，将 A/AAAA 记录指向中央服务器。
防火墙只需放行 80 和 443。节点面板默认只映射到各自服务器的 `127.0.0.1:8090`。

拉取项目后，先进入 DisQord 项目根目录（能看到 `package.json`、`deploy` 和 `docs`
目录的位置）：

```text
cd /你的路径/DisQord
docker --version
docker compose version
```

后文所有 `docker compose` 命令都在这个目录执行。项目已经固定使用
`https://registry.npmmirror.com/`，Docker 中央镜像安装中文字体时也使用清华 Debian 镜像。

## 2. 启动中央服务器

在 `deploy` 目录旁创建 `central.env`，不要提交：

```dotenv
POSTGRES_PASSWORD=生成一个强密码
ENCRYPTION_KEY=至少32位随机字符串
PAIRING_PEPPER=另一段至少32位随机字符串
```

可用以下方式分别生成两段随机值：

```text
openssl rand -base64 48
```

启动：

```text
docker compose --env-file central.env -f deploy/docker-compose.central.yml up -d --build
```

将 [`deploy/Caddyfile`](../deploy/Caddyfile) 中的 `central.example.com` 改成实际域名，并让
Caddy 读取该文件。Caddy 终止 HTTPS/WSS，再反向代理到 `127.0.0.1:8080`。不要绕过 HTTPS
把中央端口直接暴露到公网。

检查：

```text
curl https://central.example.com/api/health
```

返回 `status: ok` 后，在浏览器打开 `https://central.example.com`。首次进入时创建至少 12 位
管理员密码。

## 3. 配置大模型

进入“基础设置”：

1. 填写 OpenAI Chat Completions 兼容 API 的基础地址，例如 `https://provider.example/v1`。
2. 填写 API 密钥。
3. 分别填写翻译模型与审核模型。
4. 只有审核模型确实支持图片输入时，才打开“审核模型支持图片理解”。
5. 保存。

API 密钥经 AES-256-GCM 加密后存入 PostgreSQL，读取设置时不会返回给浏览器。若更换
`ENCRYPTION_KEY`，旧密钥将无法解密，所以必须连同数据库备份妥善保存。

“高级模式”中有四套可版本化内容：

- 翻译系统提示词
- 翻译任务模板
- 审核系统提示词
- 审核规则

修改后点击“创建并发布新版本”。固定的协议边界和“不把消息正文当指令”的规则不允许在页面中
覆盖。

## 4. 配置 QQ 节点

### 4.1 NapCat

先让 NapCat 登录目标 QQ。在 NapCat WebUI 的网络配置中启用 OneBot 11 WebSocket 服务端，
建议只监听 `127.0.0.1:3001`，并设置访问 Token。DisQord QQ 节点是 WebSocket 客户端。

### 4.2 创建配对码

中央面板进入“节点连接”，在 QQ 节点卡片中点击“生成配对码”。配对码十分钟有效、只能使用一次，
并且不能用于 Discord 节点。

### 4.3 启动

在 QQ 服务器的项目目录创建 `qq.env`：

```dotenv
CENTRAL_WSS_URL=wss://central.example.com/node
NODE_PAIRING_CODE=中央面板生成的一次性配对码
NAPCAT_ONEBOT_WS_URL=ws://host.docker.internal:3001
NAPCAT_ACCESS_TOKEN=NapCat中设置的Token
NODE_WEB_TOKEN=至少16位随机字符串
```

启动：

```text
docker compose --env-file qq.env -f deploy/docker-compose.qq.yml up -d --build
```

首次配对成功后，编辑 `qq.env` 删除 `NODE_PAIRING_CODE`，再执行：

```text
docker compose --env-file qq.env -f deploy/docker-compose.qq.yml up -d
```

节点身份、长期会话凭据和 SQLite 队列保存在 Docker 命名卷 `disqord-qq-data`。不要删除该卷；
否则需要重新配对。

本机查看节点面板：

```text
ssh -L 8090:127.0.0.1:8090 user@qq-server
```

然后浏览器打开 `http://127.0.0.1:8090`，填写 `NODE_WEB_TOKEN`。

## 5. 配置 Discord 节点

在 Discord Developer Portal 创建 Bot：

1. 打开 Message Content Intent。
2. 邀请 Bot 进入目标服务器。
3. 至少授予 View Channel、Send Messages、Attach Files、Read Message History 权限。
4. 保存 Bot Token。

中央面板生成 Discord 节点配对码。在 Discord 服务器项目目录创建 `discord.env`：

```dotenv
CENTRAL_WSS_URL=wss://central.example.com/node
NODE_PAIRING_CODE=中央面板生成的一次性配对码
DISCORD_BOT_TOKEN=Discord Bot Token
NODE_WEB_TOKEN=至少16位随机字符串
```

启动：

```text
docker compose --env-file discord.env -f deploy/docker-compose.discord.yml up -d --build
```

首次配对成功后，同样删除 `NODE_PAIRING_CODE` 并重新执行 `up -d`。节点数据保存在
`disqord-discord-data`。

## 6. 验证聊天会话

两个节点都在线后：

1. 中央面板进入“聊天会话”。
2. “自动发现”会列出 NapCat 可见 QQ 群和 Discord Bot 可发送的文字频道。
3. 选择一个会话，点击“保存并发送验证码”。
4. 到目标 QQ 群或 Discord 频道读取验证码。
5. 回到中央面板填入验证码完成验证。

验证码十分钟有效，30 秒内不能重发，连续输错五次后需重新发送。只有已验证会话可以进入转发蓝图。

## 7. 创建双向转发蓝图

进入“转发蓝图”：

1. 选择 QQ 会话，添加为“来源”。
2. 选择 Discord 会话，添加为“目标”。
3. 从来源右侧连接点拖到目标左侧连接点。
4. 再添加 Discord 来源与 QQ 目标并连线。
5. 点击“保存并发布”。

发布时中央服务会验证：会话必须已验证、节点和边必须完整、图中不能有环。发布成功后新消息立即
使用该版本。

## 8. 实际消息行为

- QQ 和 Discord 两边收到的转发结果始终是 PNG 图片。
- 卡片包含来源、发送者头像、昵称、时间、译文、原文半透明区域及图片。
- 文字与图片混合消息会合并到卡片中；长文本会分页。
- 文件、语音、视频、贴纸等不兼容类型会转成“ 不支持的消息 / Unsupported message type ”卡片。
- 回复会优先使用目标平台的原生回复关系；若旧消息尚无映射，卡片仍显示回复摘要。
- 大模型返回 `review`、图片模型能力不足或调用失败时，消息进入“人工审核”，不会静默丢失。

## 9. 更新与回滚

更新前先备份 PostgreSQL 和两个节点数据卷。随后拉取代码并在每台对应服务器执行：

```text
docker compose --env-file <对应env文件> -f <对应compose文件> up -d --build
```

数据库迁移随中央服务启动自动执行，迁移记录保存在 `schema_migrations`。生产更新前仍应先在副本
数据库演练。

常见诊断和备份命令见 [`OPERATIONS.md`](OPERATIONS.md)。
