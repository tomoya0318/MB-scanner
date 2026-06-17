#!/bin/bash
# worktree を削除し、可能なら tmux window も閉じる
#
# 動作:
# 1. .tmux-window を事前読み取り（worktree 削除後は読めなくなるため）
# 2. cwd を ORIGINAL_DIR に退避
# 3. git worktree remove
# 4. ベストエフォートで tmux kill-window
#    - 成功 → window（＝このセッション）ごと消える
#    - 失敗 / .tmux-window 無し → 完了メッセージを出して正常終了
#
# Usage: cleanup-worktree.sh <worktree-dir> <original-dir>

set -euo pipefail

WORKTREE_DIR="${1:-}"
ORIGINAL_DIR="${2:-}"

if [[ -z "$WORKTREE_DIR" ]] || [[ -z "$ORIGINAL_DIR" ]]; then
  echo "Usage: $(basename "$0") <worktree-dir> <original-dir>" >&2
  exit 1
fi

if [[ ! -d "$WORKTREE_DIR" ]]; then
  echo "Error: worktree ディレクトリが存在しません: $WORKTREE_DIR" >&2
  exit 1
fi

# サブディレクトリが渡されても動くよう worktree トップに正規化
WORKTREE_TOP=$(git -C "$WORKTREE_DIR" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$WORKTREE_TOP" ]]; then
  echo "Error: $WORKTREE_DIR は git worktree ではありません" >&2
  exit 1
fi
WORKTREE_DIR="$WORKTREE_TOP"

if [[ ! -d "$ORIGINAL_DIR" ]]; then
  echo "Error: original ディレクトリが存在しません: $ORIGINAL_DIR" >&2
  exit 1
fi

# Step 1: tmux window ID を削除前に読み取り
TMUX_WINDOW=""
if [[ -f "$WORKTREE_DIR/.tmux-window" ]]; then
  TMUX_WINDOW=$(cat "$WORKTREE_DIR/.tmux-window" 2>/dev/null || true)
fi

# Step 2: cwd を退避（呼び出し元の cwd 状態に依存しないため）
cd "$ORIGINAL_DIR"

# Step 3: worktree 削除
# SKILL.md Step 0 で clean 状態を pre-flight 済み前提。
# submodule を含む worktree では --force 無しだと
# 「ディレクトリは消えたがメタデータ整理で失敗」という partial delete を起こし、
# 呼び出し元の cwd が宙に浮く事故になるため必ず --force を付ける。
git worktree remove --force "$WORKTREE_DIR"

# Step 4: ベストエフォート tmux window close
# 通常 finish-worktree は worktree の window 内（＝このセッション）から走るため、
# 対象 window はこのスクリプト自身が動いている window になる。同期 kill すると
# 出力が途切れて呼び出し元が結果を受け取れないので、わずかに遅延させて
# バックグラウンドで kill する。
WINDOW_CLOSED=0
if [[ -n "$TMUX_WINDOW" ]] && command -v tmux >/dev/null 2>&1 \
   && tmux list-windows -a -F '#{window_id}' 2>/dev/null | grep -qx "$TMUX_WINDOW"; then
  echo "完了しました。tmux window ($TMUX_WINDOW) を閉じます。"
  ( sleep 2; tmux kill-window -t "$TMUX_WINDOW" 2>/dev/null ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
  WINDOW_CLOSED=1
fi

# ここまで来た = window が見つからない or tmux 外
if (( WINDOW_CLOSED == 0 )); then
  echo "完了しました。この window は手動で閉じてください。"
fi
