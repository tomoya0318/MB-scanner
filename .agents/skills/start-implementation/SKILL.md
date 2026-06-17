---
name: start-implementation
description: 実装開始時に作業ディレクトリ（plan/brief/review/prompt）を作成し、理解ゲート・consult ペイン・検証フェーズまで含めて実装を管理する
disable-model-invocation: true
argument-hint: /start-implementation <作業の説明>
---

# 実装開始スキル

実装作業を、main セッションの context を太らせない形で管理します。成果物を 4 ファイルに分離し、
ユーザ確認・検証は別 Claude セッション（分割ペイン）へ逃がします。

## 成果物（`tmp/NNNN_<名前>/`）

| ファイル | 読み手 / タイミング | 内容 |
|---|---|---|
| `plan.md` | コーディングエージェント / 実装中**これだけ**参照 | 詳細な全体像（調査・Phase・タスク・リスク）。**review.md へリンクしない** |
| `brief.md` | ユーザ / 承認時 | ①実装概要 ②実装の核（研究コード理解＝理解ゲート）③未決事項 |
| `review.md` | 検証セッション / **実装前に観点確定・実装中は開かない** | 警告ヘッダ + 観点 + 推奨起動形 + 結果欄 |
| `prompt.md` | 履歴 | プロンプト履歴 |
| `consult-*.md` | main / 必要時 | consult ペインの結論 |

## 使用方法

```
/start-implementation <作業の説明>
/start-implementation @file.md の内容を実装する
```

## 作業フロー

### Step 1: 作業ディレクトリの初期化

```bash
.claude/skills/start-implementation/init-work-dir.sh "<作業名>" "$(pwd)/tmp"
```

出力 JSON から `work_dir` / `plan_file` / `brief_file` / `review_file` / `prompt_file` を取得する。

### Step 2: 調査と plan.md / brief.md の作成

[references/planning-prompt.md](references/planning-prompt.md) を Plan サブエージェントのプロンプトとして使い、コードベース調査と計画策定を委譲する。サブエージェントは「実装に不可欠なファイル」「実装の核（研究コード理解）」「未決事項」を返す。

1. `prompt.md` にユーザーからの指示を**そのまま**記録（加筆・修正は禁止）
2. 調査結果をもとに `plan.md`（詳細）を記載
3. `brief.md` を記載：①実装概要 ②実装の核（研究コード理解）③未決事項

### Step 3: レビュー観点の先決め（review.md）

実装に入る**前**に、[references/review-criteria-prompt.md](references/review-criteria-prompt.md) をプロンプトとして**別サブエージェント**へ委譲し、`review.md` に観点と推奨起動形を書かせる。

- このサブエージェントは `plan.md` / `brief.md` と現状コードから観点を起草し、**`review.md` に直接書き込む**。
- **main は観点本文を ingest しない**（バイアス分離 + context 節約）。サブエージェントには「review.md に記入した」旨の 1 行だけ返させる。
- 以降、**main / 実装セッションは review.md を開かない**。

### Step 4: ユーザ提示と理解ゲート

1. **`brief.md` をユーザに提示**（肥大な plan.md ではなく要点を見せる）。
2. **理解ゲート**: brief.md の「実装の核」が薄い / 「未解明」が残るなら、**実装に入らない**。調査し直すか、未決事項として確認に回す。
3. 未決事項のうち「同期で詰めたい・main の理解だけでは決められない」ものは **consult ペイン**へ:
   ```bash
   .claude/skills/start-implementation/spawn-session.sh consult-session "<work_dir>" confirm
   ```
   ユーザは別ペインで対話し、結論は `consult-<topic>.md` に書かれる。main はそれを読んで brief/plan に反映する。
4. 実装の許可を得る（許可が出るまで brief を調整）。

**重要**: 許可前にコード変更を実施してはいけません。

### Step 5: 実装と記録

許可後：

1. 計画に従って実装する。**参照は `plan.md` のみ**（`review.md` は開かない＝観点先回りの防止）。
2. ユーザーからの追加指示・実施内容を `prompt.md` に追記。
3. 作業完了ごとに、変更対象に限定して検証する:
   - フォーマット・Lint 修正: `mise run fix`
   - 型チェック: `mise run typecheck`（TS は `mise run typecheck-analyzer`）
   - テスト: 全体は `mise run test`、一部なら `uv run pytest <対象ファイル>`（TS は `mise run test-analyzer`）

### Step 6: 検証フェーズ（別ペイン）

実装完了後、**fresh な分割ペイン**で検証する（自己正当化バイアスの分離）:

```bash
.claude/skills/start-implementation/spawn-session.sh verify-session "<work_dir>"
```

別セッションが `review.md` の観点を現物検証し（条件に応じて native `/code-review` 併用）、結果を `review.md` に追記する。要修正があれば `/apply-review` で対応する。

### Step 7: ユーザ理解用 QA（任意・別ペイン）

ユーザが変更内容を理解するための Q&A は main に載せず、別ペインへ:

```bash
.claude/skills/start-implementation/spawn-session.sh consult-session "<work_dir>" qa
```

## prompt.md のフォーマット

```markdown
# プロンプト履歴

## 初回指示 (YYYY-MM-DD)

### ユーザーからの指示

{プロンプトをそのまま貼る}

### 実施内容

実施した内容を記載

---

## フィードバック 1 (YYYY-MM-DD)

### ユーザーからのフィードバック

{プロンプトをそのまま貼る}

### 実施内容

実施した内容を記載
```

## ヒント

- 作業ディレクトリは連番管理（0001, 0002, ...）で自動採番。
- 分割ペイン系（consult / verify）は tmux 内でのみ動く（`spawn-session.sh` が `$TMUX` を要求）。
- `review.md` は実装中に開かない。観点は Step 3 で確定し、Step 6 の別セッションで使う。
- 作業完了後の tmp 移管は `finish-worktree` がディレクトリ丸ごと行うため、新ファイルも自動で main へ移送される。
