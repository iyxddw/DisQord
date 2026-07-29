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
sudo systemctl status postgresql --no-pager
pg_isready -h 127.0.0.1 -p 5432 -U disqord -d disqord
```

重点检查 `/etc/disqord/central.env` 中数据库密码、密钥长度和端口。密码含 `@`、`:`、`/` 等
字符时必须 URL 编码；最简单的做法是数据库密码仅使用字母、数字、下划线和连字符。

### 节点一直重连

- `CENTRAL_WSS_URL` 必须是 `wss://实际域名/node`。
- 节点服务器必须能访问中央域名的 HTTPS。
- 首次配对码十分钟有效且只能使用一次；过期后重新生成。
- 配对成功后删除环境文件中的 `NODE_PAIRING_CODE`，长期凭据保存在节点数据目录。

### QQ 节点无法连接 NapCat

- NapCat 已登录且 OneBot 11 WebSocket 服务端已启用。
- 原生部署地址使用 `ws://127.0.0.1:3001`。
- Access Token 两端完全一致。
- NapCat 与 QQ 节点应在同一机器；不要开放 OneBot 公网端口。

### Discord 上线但读不到正文

- 打开 Message Content Intent。
- 检查 View Channel、Read Message History、Send Messages 和 Attach Files。
- 检查具体频道覆盖权限。

### 中文卡片变成方框

```bash
sudo apt install -y fonts-noto-cjk
sudo fc-cache -f
sudo systemctl restart disqord-central
```

## 备份与恢复

### PostgreSQL

备份：

```bash
sudo -u postgres pg_dump -Fc disqord > /var/backups/disqord-$(date +%F).dump
```

恢复前停止中央服务，然后恢复到空数据库：

```bash
sudo systemctl stop disqord-central
sudo -u postgres pg_restore --clean --if-exists -d disqord /备份路径/disqord.dump
sudo systemctl start disqord-central
```

`--clean` 会覆盖目标数据库中的现有对象，只能在确认目标与备份后使用。

同时离线备份：

- `/etc/disqord/central.env`
- `/var/lib/disqord/qq`
- `/var/lib/disqord/discord`

环境文件含加密主密钥，节点目录含身份私钥、长期会话 Token 和未完成队列，均按敏感数据处理。
恢复同一节点目录时，不要同时运行两个副本。

### 从旧 Docker PostgreSQL 迁移

旧容器仍存在时导出：

```bash
docker exec deploy-postgres-1 pg_dump -U disqord -d disqord -Fc \
  > /root/disqord-from-docker.dump
```

停止旧中央容器，创建并确认原生 PostgreSQL 后导入：

```bash
sudo systemctl stop disqord-central
sudo -u postgres pg_restore --clean --if-exists -d disqord \
  /root/disqord-from-docker.dump
sudo systemctl start disqord-central
```

导入前必须让 `/etc/disqord/central.env` 使用旧部署相同的 `ENCRYPTION_KEY`，否则数据库中的大模型
API 密钥无法解密。

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
sudo -u disqord pnpm install --frozen-lockfile
sudo -u disqord pnpm build
sudo systemctl restart disqord-central
```

数据库迁移不一定可通过切换代码自动撤销，因此中央端升级前必须备份 PostgreSQL。
