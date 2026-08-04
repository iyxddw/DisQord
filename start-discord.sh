#!/usr/bin/env bash
# 启动 Discord 节点（PM2）
# 用法：./start-discord.sh    或    bash start-discord.sh
set -euo pipefail
cd "$(dirname "$0")"
exec bash pm2-start-discord.sh
