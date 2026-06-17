#!/bin/bash
# 作業ディレクトリの初期化スクリプト
# Usage: init-work-dir.sh <work-name> [base-dir]
# 生成物: plan.md（エージェント用の詳細計画）/ brief.md（ユーザ用の要点）/
#         review.md（レビュー観点・実装中は開かない）/ prompt.md（プロンプト履歴）

set -euo pipefail

WORK_NAME="${1:-}"
BASE_DIR="${2:-$(pwd)/tmp}"

if [[ -z "$WORK_NAME" ]]; then
  echo "Error: 作業名を指定してください" >&2
  echo "Usage: $0 <work-name> [base-dir]" >&2
  exit 1
fi

# base-dirが存在しない場合は作成
mkdir -p "$BASE_DIR"

# 既存ディレクトリから最大の連番を取得
MAX_NUM=0
if [[ -d "$BASE_DIR" ]]; then
  for dir in "$BASE_DIR"/[0-9][0-9][0-9][0-9]_*/; do
    if [[ -d "$dir" ]]; then
      NUM=$(basename "$dir" | grep -oE '^[0-9]+' || echo "0")
      NUM=$((10#$NUM))  # 先頭のゼロを除去して数値化
      if (( NUM > MAX_NUM )); then
        MAX_NUM=$NUM
      fi
    fi
  done
fi

# 次の連番を計算（4桁ゼロ埋め）
NEXT_NUM=$(printf "%04d" $((MAX_NUM + 1)))

# 作業名をファイル名に適した形式に変換（スペース→ハイフン、小文字化）
SAFE_NAME=$(echo "$WORK_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-_')

# 作業ディレクトリのパス
WORK_DIR="$BASE_DIR/${NEXT_NUM}_${SAFE_NAME}"

# ディレクトリを作成
mkdir -p "$WORK_DIR"

# 日付を取得
TODAY=$(date +%Y-%m-%d)

# plan.md を作成（コーディングエージェント用の詳細な全体像。実装中はこれだけ参照する）
cat > "$WORK_DIR/plan.md" << EOF
# 実行プラン: ${WORK_NAME}

作成日: ${TODAY}

> コーディングエージェント用の詳細な全体像。実装中の参照物はこのファイルに限定する。
> ユーザ向けの要点は brief.md、レビュー観点は review.md（実装中は開かない）。
> **このファイルから review.md へのリンクは張らない**（観点先回りによるバイアスを避けるため）。

## 概要

<!-- 作業の概要を記載 -->

## 目的

<!-- 達成したいゴールを記載 -->

## 調査結果

<!-- 関連ファイル、既存実装の調査結果 -->

## 実装計画

### Phase 1: 準備

- [ ] タスク1
- [ ] タスク2

### Phase 2: 実装

- [ ] タスク3
- [ ] タスク4

### Phase 3: テスト・検証

- [ ] タスク5

## 懸念事項・リスク

<!-- 考慮すべきリスクや懸念点 -->

## 備考

<!-- その他のメモ -->
EOF

# brief.md を作成（ユーザ用の要点。承認時にこれを提示する）
cat > "$WORK_DIR/brief.md" << EOF
# 実装ブリーフ: ${WORK_NAME}

作成日: ${TODAY}

> ユーザ向けの要点。詳細な実装計画は plan.md（コーディングエージェント用）にある。

## 1. 実装概要

<!-- 何を作る/変えるかを数行で。スコープと非スコープ。 -->

## 2. 実装の核（研究コード理解）

<!--
対象の研究コードを「どう理解したか」を自分の言葉で書く。
ここが薄い/曖昧なら実装フェーズに入らない（理解ゲート）。
- 触る対象の責務・データフロー・不変条件
- 実装の本質（最小で何をすれば要件を満たすか）
- 理解しきれていない箇所は正直に「未解明」として 3. へ回す
-->

## 3. 未決事項

<!--
まだ決まっていない / ユーザ判断が要るもの。
同期で詰めたいものは consult ペイン（spawn-session.sh consult-session）へ。
- [ ] <論点>: <選択肢 / トレードオフ>
-->
EOF

# review.md を作成（レビュー観点。実装前に確定し、実装中は開かない）
cat > "$WORK_DIR/review.md" << EOF
# レビュー観点: ${WORK_NAME}

作成日: ${TODAY}

> **⚠️ このファイルはレビュー専用。実装セッションでは開かないこと。**
> 実装が観点を先回りして「観点だけを通るコード」になるのを防ぐため、実装時の参照物は
> plan.md に限定する。plan.md からこのファイルへリンクも張らない。
> 観点は実装前に確定し、実装完了後に別（fresh）セッション（verify-session）で検証する。

## 共通の前置き

- PR 説明・コミットメッセージ・コード内コメントの主張を信用せず、現物（コード・git 履歴・実行結果）で検証する。
- 指摘は \`file:line\` 付き、確信度（高/中/低）を明示。修正案は強制しない。
- DoD を再走して確認する: \`mise run check-arch\` / \`mise run typecheck\` / \`mise run test\`（または変更対象を \`uv run pytest <対象>\`）/ \`mise run lint-analyzer\` が green。

## 推奨起動形

<!--
verify-session が従う。下記ルーブリックで判定して記録する:
  差分なし(ADR/docs-only)              → 不要（カスタム観点のみ）
  docs/コメント/小掃除/純機械移動       → /code-review low
  機械移動 + import 書換 / 中規模       → /code-review medium
  ロジック・挙動を含む実装             → /code-review high
  高リスク(過去バグ箇所/契約drift/挙動変更複数) → /code-review max（+ ultra を推奨提示）
共通条件: カスタム観点は常に実行 / --comment は PR があるときだけ / --fix は付けない /
          ultra は verify-session から自動起動しない（推奨提示のみ）
-->
推奨: <カスタム観点のみ | カスタム観点 + /code-review <effort>>

## 観点

<!-- タスク固有の検証観点。各観点に「何を・どの現物で・何と突き合わせるか」を書く -->

1. ...

## レビュー結果

<!--
verify-session が追記する。形式:

### レビュー結果 (YYYY-MM-DD / 使った観点・起動形)

**総合**: 1〜2 文（承認可 / 要修正・マージブロッカーの有無・DoD 再走結果）

要修正あり → 指摘テーブル: | # | 指摘箇所(file:line) | 内容 | 修正 | 確信度 |
全 OK     → 検証テーブル: | 観点 | 確認した証拠(file:line) | 結論 |

**留意点**: 要修正ではない判断を 1 行
-->
EOF

# prompt.md を作成
cat > "$WORK_DIR/prompt.md" << EOF
# プロンプト履歴

## 初回指示 (${TODAY})

### ユーザーからの指示

<!-- ここに最初のプロンプトを記載 -->

### 実施内容

<!-- 実施した内容を記載 -->
EOF

# 結果を出力（JSON形式）
echo "{"
echo "  \"work_dir\": \"$WORK_DIR\","
echo "  \"plan_file\": \"$WORK_DIR/plan.md\","
echo "  \"brief_file\": \"$WORK_DIR/brief.md\","
echo "  \"review_file\": \"$WORK_DIR/review.md\","
echo "  \"prompt_file\": \"$WORK_DIR/prompt.md\","
echo "  \"sequence_number\": \"$NEXT_NUM\","
echo "  \"work_name\": \"$SAFE_NAME\""
echo "}"
