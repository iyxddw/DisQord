# DisQord 原生部署运维与排障

本文只描述 systemd 原生部署，不使用 Docker。

## 查看服务状态与日志

```bash
sudo systemctl status disqord-central --no-pager
sudo journalctl -u disqord-central -n 200 --no-pager
```

QQ、Discord 分别将服务名换成 `disqord-qq`、`disqord-discord`。实时跟随日志：

```bash
sudo journalctl -u disqord-qq -f
```

日志可能包含聊天标识等运行信息，不要公开粘贴未经检查的完整日志。

## 常用操作

```bash
sudo systemctl restart disqord-central
sudo systemctl stop disqord-central
sudo systemctl start disqord-central
```

修改 `/etc/disqord/*.env` 后必须重启对应服务。修改 Caddyfile 后：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 健康检查

中央服务器本机：

```bash
curl http://127.0.0.1:18080/api/health
```

任意外部机器：

```bash
curl https://你的中央域名/api/health
```

节点到中央端：

```bash
curl https://你的中央域名/api/health
```

## 常见问题

### Central 启动失败

```bash
sudo journalctl -u disqord-central -n 100 --no-pager
sudo ls -lh /var/lib/disqord/central
```

重点检查 `/etc/disqord/central.env` 中数据目录路径、`PAIRING_PEPPER` 长度和端口，以及
`/var/lib/disqord/central` 是否由 `disqord` 用户拥有。首次迁移后应能看到带时间戳的
`central.json.migrated-*` 备份和拆分后的 ndjson 文件。

### 节点一直重连

- `CENTRAL_WSS_URL` 必须是 `wss://实际域名/node`。
- 节点服务器必须能访问中央域名的 HTTPS。
- 客户端首次运行会自动登记；无需预先生成或填写配对码。
- 客户端显示在线但没有已绑定会话时，到“绑定会话”选择客户端上报的目标群/频道并完成验证码。
- 长期连接凭据保存在节点数据目录；删除节点目录后会以新客户端身份重新登记。

### QQ 节点无法连接 NapCat

- NapCat 已登录且 OneBot 11 WebSocket 服务端已启用。
- 原生部署地址使用 `ws://127.0.0.1:3001`。
- Access Token 两端完全一致。
- NapCat 与 QQ 节点应在同一机器；不要开放 OneBot 公网端口。

### Discord 上线但读不到正文

- 打开 Message Content Intent。
- 检查 View Channel、Read Message History、Send Messages 和 Attach Files。
- 检查具体频道覆盖权限。

### 中文或 Emoji 卡片变成方框

```bash
sudo apt install -y fontconfig fonts-noto-cjk fonts-noto-color-emoji
sudo fc-cache -f
# 重启实际发送图片的节点，例如：
bash pm2-start-qq.sh
# 或
bash pm2-start-discord.sh
```

如果没有使用 PM2，停止对应节点后重新运行它的启动脚本。当前渲染器是客户端 Skia Canvas；中央端不会
再用 librsvg 绘制文字，因此只重启中央端或只在中央端安装字体都不能修复彩色 Emoji。

## 备份与恢复

### 中央数据

备份（新版需要备份整个中央数据目录）：

```bash
sudo install -d -m 0700 /var/backups/disqord
sudo cp -a /var/lib/disqord/central \
  /var/backups/disqord/central-$(date +%F-%H%M%S)
```

恢复时先停止中央服务，避免覆盖正在写入的数据：

```bash
sudo systemctl stop disqord-central
sudo mv /var/lib/disqord/central /var/lib/disqord/central.before-restore-$(date +%s)
sudo cp -a /备份路径/central-时间戳 /var/lib/disqord/central
sudo chown -R disqord:disqord /var/lib/disqord/central
sudo find /var/lib/disqord/central -type f -exec chmod 0600 {} \;
sudo systemctl start disqord-central
```

同时离线备份：

- `/etc/disqord/central.env`
- `/var/lib/disqord/central`
- `/var/lib/disqord/qq`
- `/var/lib/disqord/discord`

中央 ndjson 文件可能包含明文大模型 API Key；节点目录包含身份私钥、长期会话 Token 和未完成队列，
均按敏感数据处理。恢复同一节点目录时，不要同时运行两个副本。

## 回滚代码

更新前记录当前提交：

```bash
cd /opt/disqord
git rev-parse HEAD
```

如果新版本异常，切换到已确认的旧提交，重新安装、构建并重启对应服务：

```bash
cd /opt/disqord
sudo -u disqord git switch --detach 旧提交哈希
sudo -u disqord env npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 install --frozen-lockfile
sudo -u disqord env npm_config_registry=https://registry.npmmirror.com \
  npx --yes pnpm@10.14.0 build
sudo systemctl restart disqord-central
```

中央数据格式发生变化时，旧代码不一定能够读取新文件，因此中央端升级前必须备份整个
`/var/lib/disqord/central` 目录。回滚旧代码时，使用备份目录恢复旧版 `central.json`，不要
让旧代码直接读取 ndjson 文件。
