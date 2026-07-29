# DisQord 原生部署指南（不使用 Docker）

本文按三台 Linux 服务器部署：

- 中央服务器：DisQord Central、Caddy，必须有公网域名。
- QQ 服务器：NapCat 与 DisQord QQ Node。
- Discord 服务器：DisQord Discord Node。

三个 DisQord 程序均由 systemd 托管。QQ、Discord 服务器只主动连接中央服务器，无需开放
公网端口。示例适用于 Ubuntu/Debian，默认项目目录为 `/opt/disqord`。

## 1. 三台服务器的公共准备

安装 Git、下载工具和编译所需基础包：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates xz-utils build-essential
```

安装项目固定的 Node.js 24.18.0。以下命令会自动识别 x86_64 与 ARM64，并使用 npmmirror：

```bash
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "不支持的 CPU 架构：$(uname -m)"; exit 1 ;;
esac
curl -fL "https://npmmirror.com/mirrors/node/v24.18.0/node-v24.18.0-linux-${NODE_ARCH}.tar.xz" \
  -o /tmp/node-v24.18.0.tar.xz
sudo tar -xJf /tmp/node-v24.18.0.tar.xz -C /usr/local --strip-components=1
node --version
```

输出应为 `v24.18.0`。无需全局安装 pnpm，使用 npm 临时调用项目固定版本：

```bash
npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 --version
```

创建专用系统用户并安装代码。首次部署时执行：

```bash
sudo useradd --system --create-home --home-dir /var/lib/disqord \
  --shell /usr/sbin/nologin disqord 2>/dev/null || true
sudo git clone https://github.com/iyxddw/DisQord /opt/disqord
sudo chown -R disqord:disqord /opt/disqord
cd /opt/disqord
sudo -u disqord env npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 install --frozen-lockfile
sudo -u disqord env npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 build
```

若 `/opt/disqord` 已存在，不要再次 clone，参照本文“更新”章节。

## 2. 中央服务器

### 2.1 准备中央数据目录

```bash
sudo apt install -y fonts-noto-cjk
sudo install -d -m 0750 -o disqord -g disqord /var/lib/disqord/central
```

中央端的全部持久数据写入 `/var/lib/disqord/central/central.json`。文件首次启动时自动创建，
包含管理员记录、节点、会话、蓝图、日志、提示词和明文大模型 API Key，权限固定为 `0600`。

### 2.2 创建中央端环境文件

```bash
sudo install -d -m 0750 -o root -g disqord /etc/disqord
sudo cp /opt/disqord/deploy/native/central.env.example /etc/disqord/central.env
sudo nano /etc/disqord/central.env
```

将 `PAIRING_PEPPER` 替换为以下命令生成的随机值：

```bash
openssl rand -hex 48
```

中央服务固定绑定 `127.0.0.1:18080`，不会占用你原有的 8080，也不会直接暴露公网。保存后：

```bash
sudo chown root:disqord /etc/disqord/central.env
sudo chmod 0640 /etc/disqord/central.env
```

### 2.3 安装并启动 Central

```bash
sudo cp /opt/disqord/deploy/native/disqord-central.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now disqord-central
sudo systemctl status disqord-central --no-pager
```

程序启动时会自动创建数据文件。检查本机健康接口：

```bash
curl http://127.0.0.1:18080/api/health
```

应返回包含 `"status":"ok"` 的 JSON。失败时查看：

```bash
sudo journalctl -u disqord-central -n 100 --no-pager
```

### 2.4 安装 Caddy 和 HTTPS

先将域名 A 记录指向中央服务器公网 IPv4。没有可用 IPv6 时不要添加 AAAA。云安全组和 UFW
允许 TCP 80、TCP 443；UDP 443 可选：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
```

通过 Caddy 官方软件源安装（兼容系统自带仓库没有 Caddy 或版本过旧的 Ubuntu/Debian）：

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

让 Caddy 读取域名环境变量：

```bash
echo 'DISQORD_DOMAIN=你的实际域名' | sudo tee /etc/disqord/caddy.env
sudo chmod 0644 /etc/disqord/caddy.env
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/disqord/caddy.env\n' | \
  sudo tee /etc/systemd/system/caddy.service.d/disqord.conf
sudo cp /opt/disqord/deploy/native/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo systemctl restart caddy
```

这里的域名只填写 `bridge.example.com` 形式，不要带 `https://` 或路径。验证：

```bash
sudo journalctl -u caddy -n 100 --no-pager
curl https://你的实际域名/api/health
```

Caddy 自动申请、续期证书并支持 WebSocket。浏览器打开 `https://你的实际域名`，首次进入中央
面板时创建至少 12 位管理员密码。

## 3. QQ 服务器

先按第 1 节安装 Node、pnpm、代码并完成构建。

### 3.1 NapCat

在 NapCat WebUI 中启用 OneBot 11 WebSocket 服务端：

- 监听地址：`127.0.0.1`
- 端口：`3001`
- 设置一个强 Access Token

DisQord 和 NapCat 在同一服务器上时使用 `ws://127.0.0.1:3001`，不要把 OneBot 端口开放公网。

### 3.2 创建环境和服务

QQ 客户端首次启动后会自动登记到中央面板“客户端列表”，状态显示“等待验证”。先创建环境文件：

```bash
sudo install -d -m 0750 -o disqord -g disqord /var/lib/disqord/qq
sudo install -d -m 0750 -o root -g disqord /etc/disqord
sudo cp /opt/disqord/deploy/native/qq.env.example /etc/disqord/qq.env
sudo nano /etc/disqord/qq.env
```

填写中央域名、NapCat Token 和节点面板 Token，然后：

```bash
sudo chown root:disqord /etc/disqord/qq.env
sudo chmod 0640 /etc/disqord/qq.env
sudo cp /opt/disqord/deploy/native/disqord-qq.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now disqord-qq
sudo systemctl status disqord-qq --no-pager
```

客户端在线后，在中央面板填写群号并发送验证码，到该 QQ 群读取验证码并回填。验证成功后该群成为
该客户端唯一有效会话；更换群号必须重新验证。

查看日志：

```bash
sudo journalctl -u disqord-qq -f
```

节点面板只监听本机。你在自己的电脑上建立 SSH 隧道：

```bash
ssh -L 8090:127.0.0.1:8090 用户名@QQ服务器
```

浏览器打开 `http://127.0.0.1:8090`，填写 `NODE_WEB_TOKEN`。

## 4. Discord 服务器

在 Discord Developer Portal：

1. 创建 Bot 并打开 Message Content Intent。
2. 邀请 Bot 到目标服务器。
3. 授予 View Channel、Send Messages、Attach Files、Read Message History。
4. 保存 Bot Token。

按第 1 节安装并构建代码，然后创建 Discord 客户端配置：

```bash
sudo install -d -m 0750 -o disqord -g disqord /var/lib/disqord/discord
sudo install -d -m 0750 -o root -g disqord /etc/disqord
sudo cp /opt/disqord/deploy/native/discord.env.example /etc/disqord/discord.env
sudo nano /etc/disqord/discord.env
```

填写中央域名、Discord Bot Token 和节点面板 Token，然后：

```bash
sudo chown root:disqord /etc/disqord/discord.env
sudo chmod 0640 /etc/disqord/discord.env
sudo cp /opt/disqord/deploy/native/disqord-discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now disqord-discord
sudo systemctl status disqord-discord --no-pager
```

客户端首次连接后自动出现在中央面板“客户端列表”。点击配置，填写 Discord 服务器 ID 和频道
ID；中央端命令该客户端向指定频道发送验证码，回填正确后状态变为“已验证”。更换服务器或频道
必须重新验证。节点面板同样通过 SSH 隧道访问。

## 5. 面板配置

### 大模型

中央面板“基础设置”填写 OpenAI Chat Completions 兼容 API 地址、密钥、翻译模型和审核模型。
高级模式可以编辑并发布翻译、审核提示词版本。只有模型确实支持图片输入时才打开图片理解。

### 聊天会话

“聊天会话”页面只保存和展示已经配置过的群/频道。新增或更改会话统一在“客户端列表”完成：
Discord 填服务器 ID 和频道 ID，QQ 填群号；发送验证码并回填。只有验证成功的会话可以加入蓝图。

### 转发蓝图

分别创建 QQ → Discord、Discord → QQ 两条连接并发布。两边最终消息都以 PNG 图片发送，包含
头像、昵称、时间、译文和下方半透明原文。回复关系会保留；文字和图片以外的类型显示“不支持的
消息”。

## 6. 更新

每台服务器分别执行：

```bash
cd /opt/disqord
sudo -u disqord git pull --ff-only
sudo -u disqord env npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 install --frozen-lockfile
sudo -u disqord env npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 build
```

然后只重启该服务器负责的服务：

```bash
sudo systemctl restart disqord-central
# 或
sudo systemctl restart disqord-qq
# 或
sudo systemctl restart disqord-discord
```

中央端更新前复制一份 `central.json`。不要同时运行同一数据目录的两个程序副本。
