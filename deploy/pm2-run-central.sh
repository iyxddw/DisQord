#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_dir"
exec node --env-file="$project_dir/central.env" "$project_dir/apps/central-server/dist/main.js"
