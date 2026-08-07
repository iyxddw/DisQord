#!/usr/bin/env bash
# 从 DisQord 项目根目录启动 QQ 节点。
# 用法：bash deploy/pm2-start-qq.sh
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ ! -f "$project_root/package.json" || ! -f "$project_root/pnpm-workspace.yaml" || ! -f "$project_root/ecosystem.config.cjs" || ! -d "$project_root/apps/qq-node" ]]; then
  echo "错误：找不到 DisQord 项目根目录（deploy/ 的上一级）。" >&2
  exit 1
fi

if [[ ! -f "$project_root/qq.env" ]]; then
  echo "错误：项目根目录缺少 qq.env。" >&2
  exit 1
fi

if [[ ! -f "$project_root/apps/qq-node/dist/main.js" ]]; then
  echo "错误：QQ 节点尚未构建，请先运行 pnpm --filter @disqord/qq-node... build。" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：找不到 pm2，请先安装 PM2。" >&2
  exit 1
fi

mkdir -p "$project_root/logs"
if pm2 describe disqord-qq >/dev/null 2>&1; then
  pm2 delete disqord-qq
fi
pm2 start "$project_root/ecosystem.config.cjs" --only disqord-qq --update-env
pm2 save
echo "DisQord QQ 节点已由 PM2 启动。"
