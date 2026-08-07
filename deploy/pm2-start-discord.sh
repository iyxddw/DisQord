#!/usr/bin/env bash
# 从 DisQord 项目根目录启动 Discord 节点。
# 用法：bash deploy/pm2-start-discord.sh
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ ! -f "$project_root/package.json" || ! -f "$project_root/pnpm-workspace.yaml" || ! -f "$project_root/ecosystem.config.cjs" || ! -d "$project_root/apps/discord-node" ]]; then
  echo "错误：找不到 DisQord 项目根目录（deploy/ 的上一级）。" >&2
  exit 1
fi

if [[ ! -f "$project_root/discord.env" ]]; then
  echo "错误：项目根目录缺少 discord.env。" >&2
  exit 1
fi

if [[ ! -f "$project_root/apps/discord-node/dist/main.js" ]]; then
  echo "错误：Discord 节点尚未构建，请先运行 pnpm --filter @disqord/discord-node... build。" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：找不到 pm2，请先安装 PM2。" >&2
  exit 1
fi

mkdir -p "$project_root/logs"
if pm2 describe disqord-discord >/dev/null 2>&1; then
  pm2 delete disqord-discord
fi
pm2 start "$project_root/ecosystem.config.cjs" --only disqord-discord --update-env
pm2 save
echo "DisQord Discord 节点已由 PM2 启动。"
