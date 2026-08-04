#!/usr/bin/env bash
# 启动 Discord 节点（PM2）
# 用法：./start-discord.sh    或    bash start-discord.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
pm2 start ecosystem.config.cjs --only disqord-discord
pm2 save
