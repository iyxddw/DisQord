#!/usr/bin/env bash
# 从 DisQord 项目根目录启动中央服务。
# 用法：bash deploy/pm2-start-central.sh
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ ! -f "$project_root/package.json" || ! -f "$project_root/pnpm-workspace.yaml" || ! -f "$project_root/ecosystem.config.cjs" || ! -d "$project_root/apps/central-server" ]]; then
  echo "错误：找不到 DisQord 项目根目录（deploy/ 的上一级）。" >&2
  exit 1
fi

if [[ ! -f "$project_root/central.env" ]]; then
  echo "错误：项目根目录缺少 central.env。" >&2
  exit 1
fi

if [[ ! -f "$project_root/apps/central-server/dist/main.js" ]]; then
  echo "错误：中央端尚未构建，请先运行 pnpm --filter @disqord/central-server... build。" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：找不到 pm2，请先安装 PM2。" >&2
  exit 1
fi

mkdir -p "$project_root/logs"
if pm2 describe disqord-central >/dev/null 2>&1; then
  pm2 delete disqord-central
fi
pm2 start "$project_root/ecosystem.config.cjs" --only disqord-central --update-env
pm2 save
echo "DisQord Central 已由 PM2 启动。"
