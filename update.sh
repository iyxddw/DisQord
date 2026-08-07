#!/usr/bin/env bash
# 更新 DisQord 代码、依赖并构建指定部署角色。
#
# 交互使用：
#   bash update.sh
#
# 服务器使用：
#   bash update.sh central --yes
#   bash update.sh qq --yes
#   bash update.sh discord --yes
#   bash update.sh all --yes
#
# 只构建本地代码、不拉取远端：
#   bash update.sh central --no-pull
set -Eeuo pipefail
IFS=$'\n\t'

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$project_root"

usage() {
  cat <<'EOF'
用法：bash update.sh [目标] [选项]

目标（不指定目标时进入交互菜单）：
  central       更新并构建中央服务端 + 中央 Web
  qq            更新并构建 QQ 节点 + 节点 Web
  discord       更新并构建 Discord 节点 + 节点 Web
  all           更新并构建上述全部程序

选项：
  --no-pull     不从 Git 远端拉取，只同步依赖并构建本地代码
  --no-install  不执行 pnpm install
  --no-restart  构建成功后不执行对应的 deploy/pm2-start-*.sh
  --verify      构建后执行完整 typecheck 和 test
  --yes         跳过确认，适合脚本或 CI 调用
  -h, --help    显示帮助

示例：
  bash update.sh                       # 交互选择部署角色
  bash update.sh central --yes         # 更新中央服务器
  bash update.sh qq --yes              # 更新并启动/重启 QQ 节点
  bash update.sh all --yes --verify    # 更新全部并验证
  bash update.sh central --no-pull --no-restart  # 只构建当前工作区
EOF
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

info() {
  printf '[update] %s\n' "$*"
}

warn() {
  printf '[update] 警告：%s\n' "$*" >&2
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "找不到 $command_name，请先安装并加入 PATH。"
}

validate_project() {
  [[ -f package.json ]] || die "项目根目录缺少 package.json。"
  [[ -f pnpm-workspace.yaml ]] || die "项目根目录缺少 pnpm-workspace.yaml。"
  [[ -f ecosystem.config.cjs ]] || die "项目根目录缺少 ecosystem.config.cjs。"
  [[ -d apps/central-server ]] || die "项目目录不完整：缺少 apps/central-server。"
  [[ -d apps/central-web ]] || die "项目目录不完整：缺少 apps/central-web。"
  [[ -d apps/node-web ]] || die "项目目录不完整：缺少 apps/node-web。"
  [[ -d apps/qq-node ]] || die "项目目录不完整：缺少 apps/qq-node。"
  [[ -d apps/discord-node ]] || die "项目目录不完整：缺少 apps/discord-node。"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前目录不是 Git 工作区。"
}

central_selected=false
qq_selected=false
discord_selected=false
should_pull=true
should_install=true
should_restart=true
should_verify=false
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
      --no-pull) should_pull=false ;;
      --no-install) should_install=false ;;
      --no-restart) should_restart=false ;;
      --restart) should_restart=true ;; # backwards-compatible alias
      --verify) should_verify=true ;;
      --yes) assume_yes=true ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        (($# == 0)) || die "-- 后不接受额外参数。"
        break
        ;;
      -* ) die "未知选项：$1。使用 --help 查看用法。" ;;
      *) die "未知参数：$1。可用目标为 central、qq、discord、all。" ;;
    esac
    shift
  done

  if [[ "$has_target" == false ]]; then
    [[ -t 0 && -t 1 ]] || die "非交互运行时必须指定目标，例如：bash update.sh central --yes。"
    choose_interactively
  fi

  [[ "$central_selected" == true || "$qq_selected" == true || "$discord_selected" == true ]] || die "至少选择一个更新目标。"
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
    printf '请选择要更新的部署角色（↑/↓移动，空格选中，回车确认，a 全选，n 清空，q 取消）\n\n'
    for index in "${!labels[@]}"; do
      marker=' '
      [[ "${selected[$index]}" == true ]] && marker='x'
      pointer=' '
      [[ "$index" -eq "$cursor" ]] && pointer='>'
      printf '%s [%s] %s\n' "$pointer" "$marker" "${labels[$index]}"
    done
    printf '\n当前至少选择一个角色后按回车继续。\n'

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
        info '已取消更新。'
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
  info "项目目录：$project_root"
  info '更新目标：'
  [[ "$central_selected" == true ]] && printf '  - 中央端（中央服务端 + 中央 Web）\n'
  [[ "$qq_selected" == true ]] && printf '  - QQ 节点（QQ Node + 节点 Web）\n'
  [[ "$discord_selected" == true ]] && printf '  - Discord 节点（Discord Node + 节点 Web）\n'
  [[ "$should_pull" == true ]] && info '代码：拉取当前分支的上游更新（仅快进）' || info '代码：不拉取，使用当前工作区'
  [[ "$should_install" == true ]] && info '依赖：pnpm install --frozen-lockfile' || info '依赖：跳过安装'
  [[ "$should_restart" == true ]] && info '服务：构建成功后直接执行对应的 deploy/pm2-start-*.sh' || info '服务：不自动重启'
  [[ "$should_verify" == true ]] && info '验证：执行完整 typecheck 和 test' || info '验证：跳过完整 typecheck/test'
}

confirm_plan() {
  local answer

  [[ "$assume_yes" == true || "$selection_confirmed" == true ]] && return
  [[ -t 0 && -t 1 ]] || die '非交互运行需要加 --yes。'

  read -r -p '确认执行？[y/N] ' answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) info '已取消更新。'; exit 0 ;;
  esac
}

ensure_clean_before_pull() {
  local status_output tracked_changes untracked_files

  status_output="$(git status --porcelain=v1 --untracked-files=all)"
  tracked_changes="$(printf '%s\n' "$status_output" | awk 'NF && substr($0, 1, 2) != "??"')"
  untracked_files="$(printf '%s\n' "$status_output" | awk 'NF && substr($0, 1, 2) == "??"')"

  if [[ -n "$tracked_changes" ]]; then
    printf '%s\n' '检测到未提交的已跟踪修改，已停止拉取，避免覆盖本地工作：' >&2
    printf '%s\n' "$tracked_changes" | sed 's/^/  /' >&2
    die '请先提交、暂存或另存这些修改；如只想构建本地代码，请使用 --no-pull。'
  fi

  if [[ -n "$untracked_files" ]]; then
    warn '检测到未跟踪文件；若远端新增同名文件，快进更新可能会被 Git 拒绝：'
    printf '%s\n' "$untracked_files" | sed 's/^/  /' >&2
  fi
}

pull_updates() {
  local before_commit upstream_ref upstream_commit after_commit

  require_command git
  ensure_clean_before_pull

  before_commit="$(git rev-parse HEAD)"
  upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  [[ -n "$upstream_ref" ]] || die '当前分支没有配置上游分支，无法自动更新。请先设置 git branch --set-upstream-to。'

  info '正在获取远端引用……'
  git fetch --prune
  upstream_commit="$(git rev-parse "$upstream_ref")"

  if [[ "$before_commit" == "$upstream_commit" ]]; then
    info "代码已是最新（$(git rev-parse --short HEAD)）。"
    return
  fi

  info "正在快进到 $upstream_ref（$(git rev-parse --short "$upstream_commit")）……"
  git merge --ff-only "$upstream_ref"
  after_commit="$(git rev-parse HEAD)"
  info "代码已更新：$(git rev-parse --short "$before_commit") -> $(git rev-parse --short "$after_commit")。"
}

install_dependencies() {
  require_command pnpm
  info '正在同步依赖……'
  pnpm install --frozen-lockfile
}

build_central() {
  info '构建中央服务端及其依赖……'
  pnpm --filter @disqord/central-server... build
  info '构建中央 Web……'
  pnpm --filter @disqord/central-web build
}

node_web_built=false

build_node_web() {
  if [[ "$node_web_built" == true ]]; then
    return
  fi

  info '构建节点 Web……'
  pnpm --filter @disqord/node-web build
  node_web_built=true
}

build_qq() {
  info '构建 QQ 节点及其依赖……'
  pnpm --filter @disqord/qq-node... build
  build_node_web
}

build_discord() {
  info '构建 Discord 节点及其依赖……'
  pnpm --filter @disqord/discord-node... build
  build_node_web
}

verify_build() {
  info '执行完整类型检查……'
  pnpm typecheck
  info '执行完整测试……'
  pnpm test
}

restart_selected_services() {

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

validate_restart_scripts() {
  [[ -f "$project_root/deploy/pm2-start-central.sh" ]] || die '缺少 deploy/pm2-start-central.sh。'
  [[ -f "$project_root/deploy/pm2-start-qq.sh" ]] || die '缺少 deploy/pm2-start-qq.sh。'
  [[ -f "$project_root/deploy/pm2-start-discord.sh" ]] || die '缺少 deploy/pm2-start-discord.sh。'
  require_command pm2
}

main() {
  validate_project
  require_command git
  require_command pnpm
  parse_arguments "$@"

  if [[ "$should_restart" == true ]]; then
    validate_restart_scripts
  fi

  show_selection
  confirm_plan

  if [[ "$should_pull" == true ]]; then
    pull_updates
  else
    info '跳过 Git 更新。'
  fi

  if [[ "$should_install" == true ]]; then
    install_dependencies
  else
    info '跳过依赖安装。'
  fi

  [[ "$central_selected" == true ]] && build_central
  [[ "$qq_selected" == true ]] && build_qq
  [[ "$discord_selected" == true ]] && build_discord

  if [[ "$should_verify" == true ]]; then
    verify_build
  fi

  if [[ "$should_restart" == true ]]; then
    restart_selected_services
  else
    info '构建完成；由于使用了 --no-restart，运行中的服务未重启。'
  fi

  info '更新完成。'
}

main "$@"
