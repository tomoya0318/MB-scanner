#!/bin/bash
# cmuxの右ペインでセットアップ後にAI agentを起動する
# Usage: open-in-cmux.sh <worktree-dir> <original-dir> [ai-agent]
# 通常は open-in-terminal.sh から呼ばれる。環境変数 SETUP_COMMANDS で
# セットアップコマンドを上書き可能（未設定時は下記デフォルト値を使う）。
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
# submodule update は mise run setup 内に統合済 (.mise.toml [tasks.setup])。
SETUP_COMMANDS="${SETUP_COMMANDS-mise run setup}"

set -euo pipefail

WORKTREE_ABS="${1:-}"
ORIGINAL_DIR="${2:-}"
AI_AGENT="${3:-claude}"

if [ -z "$WORKTREE_ABS" ] || [ -z "$ORIGINAL_DIR" ]; then
  echo "Usage: $(basename "$0") <worktree-dir> <original-dir> [ai-agent]" >&2
  exit 1
fi

# cmuxで右側に新しいターミナルペインを作成し、Surface IDを取得
echo "cmux で右ペインを作成中..."
SURFACE_REF=$(cmux --json new-pane --direction right | jq -r '.surface_ref')

if [ -z "$SURFACE_REF" ] || [ "$SURFACE_REF" = "null" ]; then
  echo "Error: cmux からSurface IDを取得できませんでした" >&2
  echo "cmux --json new-pane --direction right の出力を確認してください" >&2
  exit 1
fi

# worktreeディレクトリに移動 → セットアップ → AI agent起動
# ORIGINAL_REPO_DIR を渡すことで、start-implementation スキルが
# tmpフォルダを元のリポジトリ側に作成する
if [ -n "$SETUP_COMMANDS" ]; then
  LAUNCH_CMD="cd \"$WORKTREE_ABS\" && $SETUP_COMMANDS && ORIGINAL_REPO_DIR=\"$ORIGINAL_DIR\" $AI_AGENT"
else
  LAUNCH_CMD="cd \"$WORKTREE_ABS\" && ORIGINAL_REPO_DIR=\"$ORIGINAL_DIR\" $AI_AGENT"
fi

cmux send --surface "$SURFACE_REF" "$LAUNCH_CMD"
cmux send-key --surface "$SURFACE_REF" "Enter"

# surface IDをworktreeに保存（finish-worktreeでペインを閉じるために使用）
echo "$SURFACE_REF" > "$WORKTREE_ABS/.cmux-surface"

echo ""
echo "完了！"
echo "  Worktree   : $WORKTREE_ABS"
echo "  元リポジトリ: $ORIGINAL_DIR (tmp はここに作成されます)"
if [ -n "$SETUP_COMMANDS" ]; then
  echo "  セットアップ: $SETUP_COMMANDS"
fi
echo "  AI agent   : $AI_AGENT"
echo "  右ペインでセットアップ後に $AI_AGENT が起動します (Surface: $SURFACE_REF)"
