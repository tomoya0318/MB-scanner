#!/bin/bash
# git worktreeを作成する（AI agent / tmux window は起動しない）
# Usage: create-worktree.sh <ブランチ名>
# Output: JSON { worktree_dir, original_dir, branch }

set -euo pipefail

FEATURE="${1:-}"
if [ -z "$FEATURE" ]; then
  echo "Error: ブランチ名を指定してください" >&2
  echo "Usage: $(basename "$0") <branch-name>" >&2
  exit 1
fi

ORIGINAL_DIR="$(pwd)"
REPO_NAME="${ORIGINAL_DIR##*/}"

# ブランチ名からworktreeディレクトリ名を生成（スラッシュをハイフンに変換）
SAFE_FEATURE=$(echo "$FEATURE" | tr '/' '-')
WORKTREE_DIR="../${REPO_NAME}-${SAFE_FEATURE}"

git worktree add "$WORKTREE_DIR" -b "$FEATURE"
WORKTREE_ABS="$(cd "$WORKTREE_DIR" && pwd)"

# .vscode/settings.json を生成（Pylance が worktree の .venv を認識するため）
mkdir -p "$WORKTREE_ABS/.vscode"
cat > "$WORKTREE_ABS/.vscode/settings.json" << 'VSCODE_EOF'
{
  "python.defaultInterpreterPath": "${workspaceFolder}/.venv/bin/python"
}
VSCODE_EOF

echo "{"
echo "  \"worktree_dir\": \"$WORKTREE_ABS\","
echo "  \"original_dir\": \"$ORIGINAL_DIR\","
echo "  \"branch\": \"$FEATURE\""
echo "}"
