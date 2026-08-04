#!/usr/bin/env bash
# 从 DisQord 项目根目录启动中央服务。
# 用法：cd /path/to/DisQord && bash pm2-start-central.sh
set -euo pipefail

if [[ ! -f package.json || ! -f pnpm-workspace.yaml || ! -f ecosystem.config.cjs || ! -d apps/central-server ]]; then
  echo "错误：请先切换到 DisQord 项目根目录，再运行此脚本。" >&2
  echo "示例：cd /root/DisQord && bash pm2-start-central.sh" >&2
  exit 1
fi

if [[ ! -f central.env ]]; then
  echo "错误：项目根目录缺少 central.env。" >&2
  exit 1
fi

if [[ ! -f apps/central-server/dist/main.js ]]; then
  echo "错误：中央端尚未构建，请先运行 pnpm --filter @disqord/central-server... build。" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：找不到 pm2，请先安装 PM2。" >&2
  exit 1
fi

mkdir -p logs
if pm2 describe disqord-central >/dev/null 2>&1; then
  pm2 delete disqord-central
fi
pm2 start ecosystem.config.cjs --only disqord-central --update-env
pm2 save
echo "DisQord Central 已由 PM2 启动。"
