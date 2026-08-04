#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$project_dir"
exec node --env-file="$project_dir/discord.env" "$project_dir/apps/discord-node/dist/main.js"
