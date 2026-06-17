#!/bin/bash
# 分割ペインで sub-session 用 skill を起動する launcher（deterministic）。
# main セッションの context を太らせないため、QA / 検証は別 Claude セッションへ逃がす。
#
# Usage: spawn-session.sh <skill> <arg> [mode]
#   <skill> : verify-session | consult-session
#   <arg>   : verify-session=work_dir(tmp/NNNN_*) / consult-session=handoff か work_dir
#   [mode]  : consult-session のとき confirm | qa（省略可）
#
# 仕様:
#   - tmux 内でのみ動作（$TMUX 必須）。現在の window を横分割し、
#     spawn 元（main）の cwd を引き継いだ別 Claude を起動する。
#   - 起動形は `claude "/<skill> <arg> [mode]"`。結論はファイル（review.md /
#     consult-*.md）に書かれ、main はそれだけを読む（会話本体は main に載らない）。

set -euo pipefail

SKILL="${1:-}"
ARG="${2:-}"
MODE="${3:-}"

if [ -z "$SKILL" ] || [ -z "$ARG" ]; then
  echo "Usage: $(basename "$0") <verify-session|consult-session> <arg> [mode]" >&2
  exit 1
fi

case "$SKILL" in
  verify-session|consult-session) ;;
  *) echo "Error: skill は verify-session か consult-session を指定してください（指定: $SKILL）" >&2; exit 1 ;;
esac

if [ -z "${TMUX:-}" ]; then
  echo "Error: tmux セッション内で実行してください（\$TMUX が未設定）" >&2
  exit 1
fi

REPO="$(pwd)"

# spawn 先で実行する slash 起動。引数は %q で shell-safe な単一トークンにする。
INVOKE="/$SKILL $ARG"
[ -n "$MODE" ] && INVOKE="$INVOKE $MODE"
SHCMD="claude $(printf '%q' "$INVOKE")"

# 横分割で別ペインを作り、フォーカスを移す（ユーザがそのまま同期作業に入れる）。
read -r PANE_ID < <(
  tmux split-window -h -P -F '#{pane_id}' -c "$REPO" "$SHCMD"
)

echo "分割ペイン ($PANE_ID) で $SKILL を起動しました。"
case "$SKILL" in
  verify-session)
    echo "  → そのペインで検証フェーズが走り、結果は review.md に追記されます。" ;;
  consult-session)
    echo "  → そのペインでユーザと同期会話し、結論は consult-*.md に書かれます。" ;;
esac
echo "  完了後、main ペインに戻り（prefix + o / 矢印）、main が結論ファイルを読みます。"
