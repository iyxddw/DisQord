#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_dir"
export DISQORD_AUTO_RESTART=true
exec node --env-file="$project_dir/qq.env" "$project_dir/apps/qq-node/dist/main.js"
