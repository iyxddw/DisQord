#!/usr/bin/env bash
# 从 DisQord 项目根目录启动 QQ 节点。
# 用法：cd /path/to/DisQord && bash pm2-start-qq.sh
set -euo pipefail

if [[ ! -f package.json || ! -f pnpm-workspace.yaml || ! -f ecosystem.config.cjs || ! -d apps/qq-node ]]; then
  echo "错误：请先切换到 DisQord 项目根目录，再运行此脚本。" >&2
  echo "示例：cd /root/DisQord && bash pm2-start-qq.sh" >&2
  exit 1
fi

if [[ ! -f qq.env ]]; then
  echo "错误：项目根目录缺少 qq.env。" >&2
  exit 1
fi

if [[ ! -f apps/qq-node/dist/index.js ]]; then
  echo "错误：QQ 节点尚未构建，请先运行 pnpm --filter @disqord/qq-node... build。" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：找不到 pm2，请先安装 PM2。" >&2
  exit 1
fi

mkdir -p logs
if pm2 describe disqord-qq >/dev/null 2>&1; then
  pm2 restart disqord-qq --update-env
else
  pm2 start ecosystem.config.cjs --only disqord-qq --update-env
fi
pm2 save
echo "DisQord QQ 节点已由 PM2 启动。"
