#!/bin/bash
# tmux の新しい window で worktree 用 AI agent セッションを起動する。
# Usage: open-in-tmux.sh <worktree-dir> <original-dir> [ai-agent]
# 通常は open-in-terminal.sh から呼ばれる。環境変数 SETUP_COMMANDS で
# セットアップコマンドを上書き可能（未設定時は下記デフォルト値を使う）。
#
# 新 window は `claude <branch>` で命名し、現在の window からはフォーカスを
# 移さない（-d でバックグラウンド作成）。ステータスバー上で main / worktree の
# Claude を見分けられるようにするのが狙い（-n で命名すると automatic-rename が
# off になり、Claude の子プロセスで名前が揺れない）。
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
# setup-dataset は setup に depends するので submodule update + Python/mb-analyzer 依存 + mb-analyzer
# のビルド (dist/cli.js) も内包する (.mise.toml [tasks.setup-dataset] → [tasks.setup] → [tasks.build-analyzer])。
# dist は gitignore で worktree に持ち越されず、Python 側が node mb-analyzer/dist/cli.js を起動するため
# 未ビルドだと実行不能。また dataset vendor の node_modules を再生成しないと integration テスト
# (server-changed-fn 等) が setup-failure → error になる。両方とも worktree 新設時から含める。
SETUP_COMMANDS="${SETUP_COMMANDS-mise run setup-dataset}"

set -euo pipefail

WORKTREE_ABS="${1:-}"
ORIGINAL_DIR="${2:-}"
AI_AGENT="${3:-claude}"

if [ -z "$WORKTREE_ABS" ] || [ -z "$ORIGINAL_DIR" ]; then
  echo "Usage: $(basename "$0") <worktree-dir> <original-dir> [ai-agent]" >&2
  exit 1
fi

if [ -z "${TMUX:-}" ]; then
  echo "Error: tmux セッション内で実行してください（\$TMUX が未設定）" >&2
  exit 1
fi

# worktree のブランチ名（window 命名に使う）
BRANCH=$(git -C "$WORKTREE_ABS" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || echo "worktree")

# worktreeディレクトリに移動 → セットアップ → AI agent起動
# ORIGINAL_REPO_DIR を渡すことで、start-implementation スキルが
# tmpフォルダを元のリポジトリ側に作成する
if [ -n "$SETUP_COMMANDS" ]; then
  LAUNCH_CMD="cd \"$WORKTREE_ABS\" && $SETUP_COMMANDS && ORIGINAL_REPO_DIR=\"$ORIGINAL_DIR\" $AI_AGENT"
else
  LAUNCH_CMD="cd \"$WORKTREE_ABS\" && ORIGINAL_REPO_DIR=\"$ORIGINAL_DIR\" $AI_AGENT"
fi

# tmux の新しい window をバックグラウンド（-d）で作成。
# -n で名前を付けると tmux の automatic-rename はその window で off になり、
# 名前 `claude <branch>` が固定される。
echo "tmux で新しい window を作成中..."
read -r WINDOW_ID WINDOW_INDEX < <(
  tmux new-window -d -P -F '#{window_id} #{window_index}' \
    -c "$WORKTREE_ABS" -n "claude $BRANCH"
)

if [ -z "${WINDOW_ID:-}" ]; then
  echo "Error: tmux window を作成できませんでした" >&2
  exit 1
fi

tmux send-keys -t "$WINDOW_ID" "$LAUNCH_CMD" Enter

# window IDをworktreeに保存（finish-worktreeでwindowを閉じるために使用）
echo "$WINDOW_ID" > "$WORKTREE_ABS/.tmux-window"

echo ""
echo "完了！"
echo "  Worktree   : $WORKTREE_ABS"
echo "  元リポジトリ: $ORIGINAL_DIR (tmp はここに作成されます)"
if [ -n "$SETUP_COMMANDS" ]; then
  echo "  セットアップ: $SETUP_COMMANDS"
fi
echo "  AI agent   : $AI_AGENT"
echo "  tmux window: [$WINDOW_INDEX] claude $BRANCH ($WINDOW_ID)"
echo "  → prefix + $WINDOW_INDEX で切り替え。window 内でセットアップ後に $AI_AGENT が起動します。"
