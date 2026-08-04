#!/usr/bin/env bash
# 启动 QQ 节点（PM2）
# 用法：./start-qq.sh    或    bash start-qq.sh
set -euo pipefail
cd "$(dirname "$0")"
exec bash pm2-start-qq.sh
