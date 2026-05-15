#!/bin/bash
# worktree 用に新しい Claude セッションを起動する（または起動コマンドを案内する）。
# cmux 環境では右ペインを開いて自動起動する。それ以外（Warp など）では、
# 「別のターミナルで実行するコマンド」を表示する（ペイン操作はしない）。
# Usage: open-in-terminal.sh <worktree-dir> <original-dir> [ai-agent]
#
# ── プロジェクトごとのカスタマイズ ────────────────────────────────────────
# SETUP_COMMANDS にセットアップコマンドを記載してください。
# 複数コマンドは && でつないでください。
# 不要な場合は空文字列 "" にすると何も実行しません。
#
# 例（Python + uv の場合）:
#   SETUP_COMMANDS="mise run python-deps"
#
# 例（npm の場合）:
#   SETUP_COMMANDS="npm install"
#
# 例（セットアップ不要な場合）:
#   SETUP_COMMANDS=""
# ──────────────────────────────────────────────────────────────────────────
SETUP_COMMANDS="git submodule update --init --recursive && mise run setup"

set -euo pipefail

WORKTREE_ABS="${1:-}"
ORIGINAL_DIR="${2:-}"
AI_AGENT="${3:-claude}"

if [ -z "$WORKTREE_ABS" ] || [ -z "$ORIGINAL_DIR" ]; then
  echo "Usage: $(basename "$0") <worktree-dir> <original-dir> [ai-agent]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SETUP_COMMANDS

# 起動後のセッションで実行するコマンド（cd → セットアップ → AI agent）。
# ORIGINAL_REPO_DIR を渡すことで start-implementation スキルが tmp を元リポジトリ側に作成する。
if [ -n "$SETUP_COMMANDS" ]; then
  LAUNCH_CMD="cd \"$WORKTREE_ABS\" && $SETUP_COMMANDS && ORIGINAL_REPO_DIR=\"$ORIGINAL_DIR\" $AI_AGENT"
else
  LAUNCH_CMD="cd \"$WORKTREE_ABS\" && ORIGINAL_REPO_DIR=\"$ORIGINAL_DIR\" $AI_AGENT"
fi

# 端末判別（WORKTREE_TERMINAL=cmux|manual で上書き可能）
TERMINAL="${WORKTREE_TERMINAL:-}"
if [ -z "$TERMINAL" ]; then
  if command -v cmux >/dev/null 2>&1; then
    TERMINAL=cmux
  else
    TERMINAL=manual
  fi
fi

if [ "$TERMINAL" = "cmux" ]; then
  exec "$SCRIPT_DIR/open-in-cmux.sh" "$WORKTREE_ABS" "$ORIGINAL_DIR" "$AI_AGENT"
fi

# manual: worktree は作成済み。あとはユーザーが自分で新しいペイン/タブ/ウィンドウへ移動して実行する。
# 可能ならコマンドをクリップボードにコピーしておく（best-effort）。
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$LAUNCH_CMD" | pbcopy && COPIED=1 || COPIED=0
else
  COPIED=0
fi

echo ""
echo "worktree を作成しました: $WORKTREE_ABS"
echo "元リポジトリ            : $ORIGINAL_DIR (tmp はここに作成されます)"
echo ""
echo "新しいターミナル（ペイン / タブ / ウィンドウ）で次を実行してください:"
echo ""
echo "  $LAUNCH_CMD"
echo ""
if [ "$COPIED" = "1" ]; then
  echo "（このコマンドはクリップボードにコピー済みです。貼り付けて実行してください）"
fi
echo "起動後のセッションで /start-implementation を使って計画・実装を行ってください。"
