#!/usr/bin/env bash
# 首次安装 DisQord：选择部署角色、端口，安装依赖、构建并启动。
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$project_root"

central_selected=false
qq_selected=false
discord_selected=false
central_port=''
qq_port=''
discord_port=''
should_install=true
should_start=true
should_verify=false
assume_yes=false
selection_confirmed=false

usage() {
  cat <<'EOF'
用法：bash install.sh [目标...] [选项]

目标（不指定时进入方向键/空格多选菜单）：
  central       中央服务端 + 中央 Web
  qq            QQ 节点 + 节点 Web
  discord       Discord 节点 + 节点 Web
  all           安装全部角色

选项：
  --central-port PORT   中央 Web/API 端口（默认 8080）
  --qq-port PORT        QQ 节点面板端口（默认 8090）
  --discord-port PORT   Discord 节点面板端口（默认 8091）
  --no-install          跳过 pnpm install
  --no-start            构建后不启动 PM2 服务
  --verify              运行完整 typecheck 和 test
  --yes                 使用默认端口并跳过确认，适合自动化
  -h, --help            显示帮助

示例：
  bash install.sh
  bash install.sh central --central-port 8080 --yes
  bash install.sh qq discord --qq-port 8090 --discord-port 8091 --yes
EOF
}

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '[install] %s\n' "$*"; }
warn() { printf '[install] 警告：%s\n' "$*" >&2; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "找不到 $1，请先安装并加入 PATH。"; }

select_all() { central_selected=true; qq_selected=true; discord_selected=true; }
select_target() {
  case "$1" in
    central) central_selected=true ;;
    qq) qq_selected=true ;;
    discord) discord_selected=true ;;
    all) select_all ;;
    *) die "未知目标：$1。" ;;
  esac
}

parse_arguments() {
  local has_target=false
  while (($# > 0)); do
    case "$1" in
      central|qq|discord|all) select_target "$1"; has_target=true ;;
      --central-port|--qq-port|--discord-port)
        (($# >= 2)) || die "$1 缺少端口值。"
        case "$1" in
          --central-port) central_port="$2" ;;
          --qq-port) qq_port="$2" ;;
          --discord-port) discord_port="$2" ;;
        esac
        shift
        ;;
      --no-install) should_install=false ;;
      --no-start) should_start=false ;;
      --verify) should_verify=true ;;
      --yes) assume_yes=true ;;
      -h|--help) usage; exit 0 ;;
      -*) die "未知选项：$1。使用 --help 查看用法。" ;;
      *) die "未知参数：$1。" ;;
    esac
    shift
  done

  if [[ "$has_target" == false ]]; then
    [[ -t 0 && -t 1 ]] || die '非交互运行时必须指定安装目标。'
    choose_interactively
  fi
}

choose_interactively() {
  local key index marker pointer has_selection
  local cursor=0
  local -a labels=(
    '中央端（中央服务端 + 中央 Web）'
    'QQ 节点（QQ Node + 节点 Web）'
    'Discord 节点（Discord Node + 节点 Web）'
  )
  local -a selected=(false false false)

  while true; do
    printf '\033[H\033[2J'
    printf '请选择要安装的部署角色（↑/↓移动，空格选中，回车确认，a 全选，n 清空，q 取消）\n\n'
    for index in "${!labels[@]}"; do
      marker=' '
      [[ "${selected[$index]}" == true ]] && marker='x'
      pointer=' '
      [[ "$index" -eq "$cursor" ]] && pointer='>'
      printf '%s [%s] %s\n' "$pointer" "$marker" "${labels[$index]}"
    done
    printf '\n至少选择一个角色后按回车继续。\n'
    IFS= read -r -s -n 1 key
    case "$key" in
      $'\x1b')
        IFS= read -r -s -n 2 key
        case "$key" in
          '[A') cursor=$(( (cursor + ${#labels[@]} - 1) % ${#labels[@]} )) ;;
          '[B') cursor=$(( (cursor + 1) % ${#labels[@]} )) ;;
        esac
        ;;
      ' ') [[ "${selected[$cursor]}" == true ]] && selected[$cursor]=false || selected[$cursor]=true ;;
      a|A) selected=(true true true) ;;
      n|N) selected=(false false false) ;;
      q|Q) printf '\033[H\033[2J'; info '已取消安装。'; exit 0 ;;
      $'\r'|$'\n'|'')
        has_selection=false
        for index in "${!selected[@]}"; do
          [[ "${selected[$index]}" == true ]] && has_selection=true
        done
        [[ "$has_selection" == true ]] && break
        ;;
    esac
  done
  central_selected="${selected[0]}"
  qq_selected="${selected[1]}"
  discord_selected="${selected[2]}"
  selection_confirmed=true
  printf '\033[H\033[2J'
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)) || die "端口无效：$1。"
}

read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

choose_port() {
  local variable_name="$1" label="$2" default_port="$3" env_file="$4" env_key="$5"
  local current value
  current="$(read_env_value "$env_file" "$env_key")"
  [[ "$current" =~ ^[0-9]+$ ]] && default_port="$current"
  value="${!variable_name}"
  if [[ -z "$value" ]]; then
    if [[ "$assume_yes" == true ]]; then
      value="$default_port"
    else
      read -r -p "$label [$default_port]：" value
      value="${value:-$default_port}"
    fi
  fi
  validate_port "$value"
  printf -v "$variable_name" '%s' "$value"
}

choose_ports() {
  [[ "$central_selected" == true ]] && choose_port central_port '中央 Web/API 端口' 8080 central.env CENTRAL_PORT
  [[ "$qq_selected" == true ]] && choose_port qq_port 'QQ 节点面板端口' 8090 qq.env NODE_WEB_PORT
  [[ "$discord_selected" == true ]] && choose_port discord_port 'Discord 节点面板端口' 8091 discord.env NODE_WEB_PORT
  local -a selected_ports=()
  [[ "$central_selected" == true ]] && selected_ports+=("$central_port")
  [[ "$qq_selected" == true ]] && selected_ports+=("$qq_port")
  [[ "$discord_selected" == true ]] && selected_ports+=("$discord_port")
  if ((${#selected_ports[@]} > 1)); then
    local unique_count
    unique_count="$(printf '%s\n' "${selected_ports[@]}" | sort -u | wc -l | tr -d ' ')"
    ((${#selected_ports[@]} == unique_count)) || die '同一台机器上安装多个角色时，面板端口不能重复。'
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  fi
}

set_env_value() {
  local file="$1" key="$2" value="$3" temporary
  temporary="${file}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { written = 0 }
    index($0, key "=") == 1 { if (!written) print key "=" value; written = 1; next }
    { print }
    END { if (!written) print key "=" value }
  ' "$file" > "$temporary"
  mv "$temporary" "$file"
  chmod 600 "$file"
}

configure_central() {
  local existing_pepper
  if [[ ! -f central.env ]]; then
    local pepper
    pepper="$(random_secret)"
    printf '%s\n' \
      'CENTRAL_HOST=0.0.0.0' \
      "CENTRAL_PORT=$central_port" \
      'CENTRAL_DATA_PATH=./data/central.json' \
      'CENTRAL_AVATAR_CACHE_PATH=./data/avatar-cache' \
      "PAIRING_PEPPER=$pepper" \
      'COOKIE_SECURE=false' > central.env
    chmod 600 central.env
    info '已创建 central.env，并自动生成配对密钥。'
  else
    set_env_value central.env CENTRAL_PORT "$central_port"
    existing_pepper="$(read_env_value central.env PAIRING_PEPPER)"
    if ((${#existing_pepper} < 32)); then
      set_env_value central.env PAIRING_PEPPER "$(random_secret)"
      info '现有 central.env 缺少有效配对密钥，已自动生成。'
    fi
    info '保留现有 central.env，仅更新中央端口。'
  fi
}

configure_qq() {
  if [[ ! -f qq.env ]]; then
    local panel_token
    panel_token="$(random_secret)"
    printf '%s\n' \
      'NODE_WEB_HOST=0.0.0.0' \
      "NODE_WEB_PORT=$qq_port" \
      "NODE_WEB_TOKEN=$panel_token" \
      'NODE_WEB_ROOT=./apps/node-web/dist' \
      'NODE_SETUP_PATH=./data/qq-setup.json' \
      'NODE_CONFIG_PATH=./data/qq-node.json' \
      'NODE_QUEUE_PATH=./data/qq-queue.json' \
      'NODE_LOG_PATH=./logs/qq-node.jsonl' > qq.env
    chmod 600 qq.env
    info '已创建 qq.env；中央地址和 NapCat 凭据将在网页首次启动向导中填写。'
  else
    set_env_value qq.env NODE_WEB_PORT "$qq_port"
    if [[ -z "$(read_env_value qq.env NODE_WEB_TOKEN)" ]]; then
      set_env_value qq.env NODE_WEB_TOKEN "$(random_secret)"
      info '现有 qq.env 缺少面板令牌，已自动生成。'
    fi
    info '保留现有 qq.env，仅更新 QQ 节点面板端口。'
  fi
}

configure_discord() {
  if [[ ! -f discord.env ]]; then
    local panel_token
    panel_token="$(random_secret)"
    printf '%s\n' \
      'NODE_WEB_HOST=0.0.0.0' \
      "NODE_WEB_PORT=$discord_port" \
      "NODE_WEB_TOKEN=$panel_token" \
      'NODE_WEB_ROOT=./apps/node-web/dist' \
      'NODE_SETUP_PATH=./data/discord-setup.json' \
      'NODE_CONFIG_PATH=./data/discord-node.json' \
      'NODE_QUEUE_PATH=./data/discord-queue.json' \
      'NODE_LOG_PATH=./logs/discord-node.jsonl' \
      'DISCORD_DEFAULT_EMOJI_DIR=./apps/discord-node/default-emojis' > discord.env
    chmod 600 discord.env
    info '已创建 discord.env；中央地址和 Bot Token 将在网页首次启动向导中填写。'
  else
    set_env_value discord.env NODE_WEB_PORT "$discord_port"
    if [[ -z "$(read_env_value discord.env NODE_WEB_TOKEN)" ]]; then
      set_env_value discord.env NODE_WEB_TOKEN "$(random_secret)"
      info '现有 discord.env 缺少面板令牌，已自动生成。'
    fi
    info '保留现有 discord.env，仅更新 Discord 节点面板端口。'
  fi
}

prepare_tools() {
  require_command node
  require_command npm
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 && major < 25 || major === 22 && minor >= 22 ? 0 : 1)" || die "需要 Node.js >=22.22.0 <25，当前为 $(node --version)。"
  if ! command -v pnpm >/dev/null 2>&1; then
    require_command corepack
    info '正在启用 pnpm 10.14.0……'
    corepack enable
    corepack prepare pnpm@10.14.0 --activate
  fi
  if [[ "$should_start" == true ]] && ! command -v pm2 >/dev/null 2>&1; then
    info '正在安装 PM2……'
    npm install --global pm2
  fi
}

install_node_fonts() {
  [[ "$qq_selected" == true || "$discord_selected" == true ]] || return
  if command -v fc-match >/dev/null 2>&1 && fc-match 'Noto Sans CJK SC' | grep -qi 'Noto'; then
    info '中文字体已经可用。'
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    warn '未检测到 apt-get，请自行安装 Noto CJK 和 Noto Color Emoji 字体。'
    return
  fi
  local -a privilege=()
  if [[ "$(id -u)" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || { warn '需要 root 或 sudo 才能安装字体，请稍后手动安装。'; return; }
    privilege=(sudo)
  fi
  info '正在安装卡片渲染所需的中文和彩色 Emoji 字体……'
  "${privilege[@]}" apt-get update
  "${privilege[@]}" apt-get install -y fontconfig fonts-noto-cjk fonts-noto-color-emoji
  "${privilege[@]}" fc-cache -f
}

build_selected() {
  if [[ "$should_install" == true ]]; then
    info '正在安装锁定依赖……'
    pnpm install --frozen-lockfile
  fi
  if [[ "$central_selected" == true ]]; then
    pnpm --filter @disqord/central-server... build
    pnpm --filter @disqord/central-web build
  fi
  if [[ "$qq_selected" == true || "$discord_selected" == true ]]; then
    pnpm --filter @disqord/node-web build
  fi
  [[ "$qq_selected" == true ]] && pnpm --filter @disqord/qq-node... build
  [[ "$discord_selected" == true ]] && pnpm --filter @disqord/discord-node... build
  if [[ "$should_verify" == true ]]; then
    pnpm typecheck
    pnpm test
  fi
}

start_selected() {
  [[ "$central_selected" == true ]] && bash deploy/pm2-start-central.sh
  [[ "$qq_selected" == true ]] && bash deploy/pm2-start-qq.sh
  [[ "$discord_selected" == true ]] && bash deploy/pm2-start-discord.sh
}

show_plan() {
  info "项目目录：$project_root"
  info '安装目标与端口：'
  [[ "$central_selected" == true ]] && printf '  - 中央端：%s\n' "$central_port"
  [[ "$qq_selected" == true ]] && printf '  - QQ 节点：%s\n' "$qq_port"
  [[ "$discord_selected" == true ]] && printf '  - Discord 节点：%s\n' "$discord_port"
  [[ "$should_start" == true ]] && info '服务：构建后由 PM2 启动' || info '服务：不自动启动'
}

confirm_plan() {
  local answer
  [[ "$assume_yes" == true || "$selection_confirmed" == true ]] && return
  read -r -p '确认安装？[y/N] ' answer
  [[ "$answer" =~ ^([yY]|yes|YES)$ ]] || { info '已取消安装。'; exit 0; }
}

show_result() {
  printf '\n'
  info '安装完成。请在浏览器中继续首次启动配置：'
  [[ "$central_selected" == true ]] && printf '  - 中央端：http://<服务器 IP>:%s\n' "$central_port"
  if [[ "$qq_selected" == true ]]; then
    printf '  - QQ 节点：http://<服务器 IP>:%s\n' "$qq_port"
    printf '    面板令牌：%s\n' "$(read_env_value qq.env NODE_WEB_TOKEN)"
  fi
  if [[ "$discord_selected" == true ]]; then
    printf '  - Discord 节点：http://<服务器 IP>:%s\n' "$discord_port"
    printf '    面板令牌：%s\n' "$(read_env_value discord.env NODE_WEB_TOKEN)"
  fi
  [[ "$central_selected" == true ]] && warn '当前中央端允许 HTTP 登录；配置 HTTPS 反向代理后，请把 central.env 的 COOKIE_SECURE 改为 true。'
}

main() {
  [[ -f package.json && -f pnpm-workspace.yaml ]] || die '请在完整的 DisQord 项目目录中运行。'
  parse_arguments "$@"
  [[ "$central_selected" == true || "$qq_selected" == true || "$discord_selected" == true ]] || die '至少选择一个安装目标。'
  choose_ports
  show_plan
  confirm_plan
  prepare_tools
  install_node_fonts
  mkdir -p data logs
  [[ "$central_selected" == true ]] && configure_central
  [[ "$qq_selected" == true ]] && configure_qq
  [[ "$discord_selected" == true ]] && configure_discord
  build_selected
  [[ "$should_start" == true ]] && start_selected
  show_result
}

main "$@"
