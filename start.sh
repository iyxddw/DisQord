#!/usr/bin/env bash
# 启动 DisQord 服务（PM2）。
#
# 交互使用：
#   bash start.sh
#
# 服务器使用：
#   bash start.sh central --yes
#   bash start.sh qq --yes
#   bash start.sh discord --yes
#   bash start.sh all --yes
set -Eeuo pipefail
IFS=$'\n\t'

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$project_root"

usage() {
  cat <<'EOF'
用法：bash start.sh [目标] [选项]

目标（不指定目标时进入交互菜单）：
  central       启动/重启中央服务端
  qq            启动/重启 QQ 节点
  discord       启动/重启 Discord 节点
  all           启动/重启上述全部服务

选项：
  --yes         跳过确认，适合脚本或 CI 调用
  -h, --help    显示帮助

示例：
  bash start.sh                 # 交互选择要启动的服务
  bash start.sh central --yes   # 直接启动中央端
  bash start.sh all --yes       # 启动全部服务
EOF
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

info() {
  printf '[start] %s\n' "$*"
}

central_selected=false
qq_selected=false
discord_selected=false
assume_yes=false
selection_confirmed=false

select_all() {
  central_selected=true
  qq_selected=true
  discord_selected=true
}

select_target() {
  case "$1" in
    central) central_selected=true ;;
    qq) qq_selected=true ;;
    discord) discord_selected=true ;;
    all) select_all ;;
    *) die "未知目标：$1。可用目标为 central、qq、discord、all。" ;;
  esac
}

parse_arguments() {
  local has_target=false

  while (($# > 0)); do
    case "$1" in
      central|qq|discord|all)
        select_target "$1"
        has_target=true
        ;;
      --yes) assume_yes=true ;;
      -h|--help)
        usage
        exit 0
        ;;
      -*) die "未知选项：$1。使用 --help 查看用法。" ;;
      *) die "未知参数：$1。可用目标为 central、qq、discord、all。" ;;
    esac
    shift
  done

  if [[ "$has_target" == false ]]; then
    [[ -t 0 && -t 1 ]] || die "非交互运行时必须指定目标，例如：bash start.sh central --yes。"
    choose_interactively
  fi

  [[ "$central_selected" == true || "$qq_selected" == true || "$discord_selected" == true ]] || die "至少选择一个启动目标。"
}

choose_interactively() {
  local key index marker pointer has_selection
  local cursor=0
  local -a labels=(
    '中央端（中央服务端）'
    'QQ 节点'
    'Discord 节点'
  )
  local -a selected=(false false false)

  while true; do
    printf '\033[H\033[2J'
    printf '请选择要启动的服务（↑/↓移动，空格选中，回车确认，a 全选，n 清空，q 取消）\n\n'
    for index in "${!labels[@]}"; do
      marker=' '
      [[ "${selected[$index]}" == true ]] && marker='x'
      pointer=' '
      [[ "$index" -eq "$cursor" ]] && pointer='>'
      printf '%s [%s] %s\n' "$pointer" "$marker" "${labels[$index]}"
    done
    printf '\n当前至少选择一个服务后按回车继续。\n'

    IFS= read -r -s -n 1 key

    case "$key" in
      $'\x1b')
        # 方向键会在 ESC 后发送 [A / [B。
        IFS= read -r -s -n 2 key
        case "$key" in
          '[A') cursor=$(( (cursor + ${#labels[@]} - 1) % ${#labels[@]} )) ;;
          '[B') cursor=$(( (cursor + 1) % ${#labels[@]} )) ;;
        esac
        ;;
      ' ')
        if [[ "${selected[$cursor]}" == true ]]; then
          selected[$cursor]=false
        else
          selected[$cursor]=true
        fi
        ;;
      a|A)
        selected=(true true true)
        ;;
      n|N)
        selected=(false false false)
        ;;
      q|Q)
        printf '\033[H\033[2J'
        info '已取消。'
        exit 0
        ;;
      $'\r'|$'\n'|'')
        has_selection=false
        for index in "${!selected[@]}"; do
          if [[ "${selected[$index]}" == true ]]; then
            has_selection=true
            break
          fi
        done
        if [[ "$has_selection" == true ]]; then
          break
        fi
        ;;
    esac
  done

  central_selected="${selected[0]}"
  qq_selected="${selected[1]}"
  discord_selected="${selected[2]}"
  selection_confirmed=true
  printf '\033[H\033[2J'
}

show_selection() {
  info '启动目标：'
  [[ "$central_selected" == true ]] && printf '  - 中央端（中央服务端）\n'
  [[ "$qq_selected" == true ]] && printf '  - QQ 节点\n'
  [[ "$discord_selected" == true ]] && printf '  - Discord 节点\n'

  # 未选中最后一个目标不是错误。显式成功返回，避免 set -e 在只选择
  # 中央端或 QQ 节点时把最后一个 [[ ... ]] 的状态 1 当成脚本失败。
  return 0
}

confirm_plan() {
  local answer

  [[ "$assume_yes" == true || "$selection_confirmed" == true ]] && return
  [[ -t 0 && -t 1 ]] || die '非交互运行需要加 --yes。'

  read -r -p '确认启动？[y/N] ' answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) info '已取消。'; exit 0 ;;
  esac
}

validate_restart_scripts() {
  [[ -f "$project_root/deploy/pm2-start-central.sh" ]] || die '缺少 deploy/pm2-start-central.sh。'
  [[ -f "$project_root/deploy/pm2-start-qq.sh" ]] || die '缺少 deploy/pm2-start-qq.sh。'
  [[ -f "$project_root/deploy/pm2-start-discord.sh" ]] || die '缺少 deploy/pm2-start-discord.sh。'
  command -v pm2 >/dev/null 2>&1 || die '找不到 pm2，请先安装 PM2。'
}

start_selected_services() {
  if [[ "$central_selected" == true ]]; then
    info '正在执行 deploy/pm2-start-central.sh……'
    bash "$project_root/deploy/pm2-start-central.sh"
  fi
  if [[ "$qq_selected" == true ]]; then
    info '正在执行 deploy/pm2-start-qq.sh……'
    bash "$project_root/deploy/pm2-start-qq.sh"
  fi
  if [[ "$discord_selected" == true ]]; then
    info '正在执行 deploy/pm2-start-discord.sh……'
    bash "$project_root/deploy/pm2-start-discord.sh"
  fi
}

main() {
  [[ -d "$project_root/apps" ]] || die "找不到 DisQord 项目目录：$project_root"
  parse_arguments "$@"
  validate_restart_scripts
  show_selection
  confirm_plan
  start_selected_services
  info '启动完成。'
}

main "$@"
