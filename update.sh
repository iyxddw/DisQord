#!/usr/bin/env bash
# 拉取 DisQord 更新、同步依赖，并交互选择要构建的程序。
# 用法：cd /path/to/DisQord && bash update.sh
set -euo pipefail

if [[ ! -f package.json || ! -f pnpm-workspace.yaml || ! -f ecosystem.config.cjs || ! -d apps ]]; then
  echo "错误：请先切换到 DisQord 项目根目录，再运行此脚本。" >&2
  echo "示例：cd /root/DisQord && bash update.sh" >&2
  exit 1
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "错误：update.sh 需要在交互式终端中运行，才能使用空格勾选和回车确认。" >&2
  exit 1
fi

for command_name in git pnpm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "错误：找不到 $command_name，请先安装并加入 PATH。" >&2
    exit 1
  fi
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "错误：当前目录不是 Git 工作区。" >&2
  exit 1
fi

repository_root="$(git rev-parse --show-toplevel)"
current_directory="$(pwd -P)"
repository_root="$(cd "$repository_root" && pwd -P)"
if [[ "$current_directory" != "$repository_root" ]]; then
  echo "错误：请在 DisQord 项目根目录执行，不能从子目录或其他目录运行。" >&2
  echo "当前目录：$current_directory" >&2
  echo "项目根目录：$repository_root" >&2
  exit 1
fi

all_tracked_changes="$(git diff --name-only; git diff --cached --name-only)"
# The updater can be edited locally while it is being used.  Do not let the
# updater block itself; git pull will still refuse a real conflict if the
# remote also changed this file.
tracked_changes="$(printf '%s\n' "$all_tracked_changes" | awk 'NF && $0 != "update.sh"')"
if [[ -n "$all_tracked_changes" && -z "$tracked_changes" ]]; then
  echo "提示：检测到 update.sh 本身有本地修改，继续执行；如远端也修改此文件，git pull 会停止。" >&2
fi
if [[ -n "$tracked_changes" ]]; then
  echo "错误：检测到未提交的已跟踪修改，已停止更新以避免覆盖本地工作：" >&2
  printf '%s\n' "$tracked_changes" | sed 's/^/  /' >&2
  echo "请先提交或暂存这些修改后再运行 update.sh。" >&2
  exit 1
fi

untracked_files="$(git ls-files --others --exclude-standard)"
if [[ -n "$untracked_files" ]]; then
  echo "警告：检测到未跟踪文件；若远端新增同名文件，git pull 可能会拒绝合并：" >&2
  printf '%s\n' "$untracked_files" | sed 's/^/  /' >&2
fi

echo "正在拉取远端更新（仅允许快进合并）……"
git pull --ff-only

echo "正在同步依赖……"
pnpm install --frozen-lockfile

labels=(
  '中央服务端'
  '中央 Web 控制面板'
  'QQ 节点'
  'Discord 节点'
)
selected=(false false false false)
cursor=0

draw_menu() {
  printf '\033[H\033[2J'
  echo '选择要构建的程序（↑/↓移动，空格勾选，回车确认，a 全选，n 清空，q 退出）'
  echo
  local index marker pointer
  for index in "${!labels[@]}"; do
    marker=' '
    [[ "${selected[$index]}" == true ]] && marker='x'
    pointer=' '
    [[ "$index" -eq "$cursor" ]] && pointer='>'
    printf '%s [%s] %s\n' "$pointer" "$marker" "${labels[$index]}"
  done
  echo
  echo '提示：中央服务端和中央 Web 是两个独立构建项；只更新节点时无需构建中央端。'
}

while true; do
  draw_menu
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
      selected=(true true true true)
      ;;
    n|N)
      selected=(false false false false)
      ;;
    q|Q)
      printf '\033[H\033[2J'
      echo '已取消更新。'
      exit 0
      ;;
    $'\r'|'')
      has_selection=false
      for index in "${!selected[@]}"; do
        [[ "${selected[$index]}" == true ]] && has_selection=true
      done
      if [[ "$has_selection" == true ]]; then break; fi
      ;;
  esac
done

printf '\033[H\033[2J'
echo '开始构建：'
for index in "${!labels[@]}"; do
  [[ "${selected[$index]}" == true ]] && echo "  - ${labels[$index]}"
done
echo

if [[ "${selected[0]}" == true ]]; then
  pnpm --filter @disqord/central-server... build
fi
if [[ "${selected[1]}" == true ]]; then
  pnpm --filter @disqord/central-web build
fi
if [[ "${selected[2]}" == true ]]; then
  pnpm --filter @disqord/qq-node... build
fi
if [[ "${selected[3]}" == true ]]; then
  pnpm --filter @disqord/discord-node... build
fi

echo
echo '更新和构建完成。运行中的 PM2 进程不会自动重启；需要时再执行对应的 pm2-start-*.sh。'
