#!/usr/bin/env bash
# 启动 DisQord 中央端（PM2）
# 用法：./start-central.sh    或    bash start-central.sh
set -euo pipefail
cd "$(dirname "$0")"
exec bash pm2-start-central.sh
