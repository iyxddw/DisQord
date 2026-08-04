#!/usr/bin/env bash
# 启动 QQ 节点（PM2）
# 用法：./start-qq.sh    或    bash start-qq.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
pm2 start ecosystem.config.cjs --only disqord-qq
pm2 save
