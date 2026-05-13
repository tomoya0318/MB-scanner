#!/usr/bin/env bash
# tmp/0022_preprocess-workload-reachability-redesign/ 内の Python スクリプトを brain-2 へ送る。
# tmp/ は exclude-list.txt により `mise run sync:brain2` の対象外なので個別に scp する。
# 送り先 (host パス) = brain-2:/mnt/data1/tomoya-n/MB-Scanner/tmp/0022_... = コンテナ内では ~/workspace/tmp/0022_...
#
# usage: bash tmp/0022_preprocess-workload-reachability-redesign/scp_to_server.sh
set -euo pipefail

REMOTE=brain-2
REMOTE_DIR=/mnt/data1/tomoya-n/MB-Scanner/tmp/0022_preprocess-workload-reachability-redesign
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
scp "$LOCAL_DIR"/*.py "$REMOTE:$REMOTE_DIR/"
echo "✅ sent $(cd "$LOCAL_DIR" && ls *.py | tr '\n' ' ')-> $REMOTE:$REMOTE_DIR"
