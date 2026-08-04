#!/usr/bin/env bash
# 从 DisQord 项目根目录启动 Discord 节点。
# 用法：cd /path/to/DisQord && bash pm2-start-discord.sh
set -euo pipefail

if [[ ! -f package.json || ! -f pnpm-workspace.yaml || ! -f ecosystem.config.cjs || ! -d apps/discord-node ]]; then
  echo "错误：请先切换到 DisQord 项目根目录，再运行此脚本。" >&2
  echo "示例：cd /root/DisQord && bash pm2-start-discord.sh" >&2
  exit 1
fi

if [[ ! -f discord.env ]]; then
  echo "错误：项目根目录缺少 discord.env。" >&2
  exit 1
fi

if [[ ! -f apps/discord-node/dist/main.js ]]; then
  echo "错误：Discord 节点尚未构建，请先运行 pnpm --filter @disqord/discord-node... build。" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：找不到 pm2，请先安装 PM2。" >&2
  exit 1
fi

mkdir -p logs
if pm2 describe disqord-discord >/dev/null 2>&1; then
  pm2 delete disqord-discord
fi
pm2 start ecosystem.config.cjs --only disqord-discord --update-env
pm2 save
echo "DisQord Discord 节点已由 PM2 启动。"
