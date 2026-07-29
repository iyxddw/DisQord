# 运维与排障

## 查看状态

中央服务：

```text
docker compose --env-file central.env -f deploy/docker-compose.central.yml ps
docker compose --env-file central.env -f deploy/docker-compose.central.yml logs --tail 200 central
```

QQ 或 Discord 节点分别把文件名替换为对应 Compose 文件。日志会隐藏 Cookie、授权头、
LLM API Key 和节点会话凭据；仍不建议把完整日志公开发布。

## 常见问题

### 节点一直显示“正在重连”

- 确认 `CENTRAL_WSS_URL` 是 `wss://实际域名/node`，末尾包含 `/node`。
- 从节点服务器访问 `https://实际域名/api/health`。
- 检查反向代理支持 WebSocket Upgrade；Caddy 示例默认支持。
- 若首次配对码已过期，中央面板重新生成并替换环境变量。
- 若配对已经成功，不要继续保留旧配对码；长期凭据在节点数据卷中。

### QQ 节点无法连接 NapCat

- 确认 NapCat 已登录且 OneBot WebSocket 服务端已开启。
- 确认地址、端口和 Access Token 一致。
- Docker 部署使用 `host.docker.internal`；非 Docker 部署通常使用 `127.0.0.1`。
- NapCat 与 QQ 节点同机时，不要把 OneBot 端口暴露到公网。

### Discord 能上线但读不到正文

- 在 Developer Portal 打开 Message Content Intent。
- 重新检查频道 View Channel 与 Read Message History 权限。
- 检查 Bot 是否被频道覆盖权限拒绝。

### 图片消息进入人工审核

“基础设置”中的图片理解开关默认关闭。只有审核模型及兼容 API 确实接受图片输入时才打开；否则
包含图片的消息会进入人工审核，这是预期的安全降级。

### 中文卡片变成方框

官方中央 Dockerfile已安装 Noto CJK 字体。若直接在宿主机运行，安装 Noto Sans CJK，并重启中央
服务。

## 备份

PostgreSQL：

```text
docker compose --env-file central.env -f deploy/docker-compose.central.yml exec -T postgres pg_dump -U disqord -d disqord -Fc > disqord.dump
```

同时离线备份：

- `central.env` 中的 `ENCRYPTION_KEY` 与 `PAIRING_PEPPER`
- Docker 卷 `disqord-qq-data`
- Docker 卷 `disqord-discord-data`

节点卷包含身份私钥、中央会话 Token 和未完成队列，按敏感数据处理。恢复时应恢复到原节点，不要
同时运行同一份节点身份的两个副本。

## 安全边界

- 中央 Web 面板只通过 HTTPS 使用。
- 节点面板保持绑定 `127.0.0.1`，通过 SSH 隧道访问。
- NapCat OneBot 接口不暴露公网。
- Discord Bot Token、NapCat Token、LLM Key 和 `.env` 文件不进入 Git。
- 怀疑节点凭据泄漏时，停止节点、删除其节点数据卷并重新配对；数据库中的旧节点会话也应标记为
  撤销。
