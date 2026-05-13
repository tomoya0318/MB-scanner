---
name: apply-review
description: PR のレビューコメントを取得し、修正方針をユーザー承認してから一括対応する
argument-hint: <PR番号（省略時は現在ブランチのPRを自動検出）>
---

# apply-review スキル

現在のブランチ / 指定 PR に付いたレビューコメントを取得し、**修正方針をユーザーに提示して承認を得てから**コードを修正する。承認なしで勝手に書き換えない。

コメントへの返信は **skill の責務外**。修正内容の要約をユーザーに報告し、返信はユーザー判断で手動に任せる。

## 使用方法

```
/apply-review [PR番号]
```

省略時は `gh pr view --json number` で現在ブランチの PR を自動検出する。

## 実行手順

### Step 1: PR の特定

- 引数で PR 番号が指定されていればそれを使う
- なければ現在ブランチから推定:
  ```bash
  gh pr view --json number -q .number
  ```
- 未プッシュ / PR 未作成なら「先に `/create-pr` してください」と伝えて中断

### Step 2: コメントと review 本体の取得

以下を **並列実行** して全部の論点を集める。1 つだけ取ると reviewer の総評や inline を取りこぼす。

```bash
# inline レビューコメント (行単位)
gh api repos/<owner>/<repo>/pulls/<N>/comments

# issue-level コメント (レビューと独立)
gh api repos/<owner>/<repo>/issues/<N>/comments

# review 本体 (総評 + state: APPROVED/CHANGES_REQUESTED/COMMENTED)
gh pr view <N> --json reviews,reviewDecision,state
```

owner/repo は `gh repo view --json nameWithOwner -q .nameWithOwner` で取得。

### Step 3: コメントの分析と分類

各コメントを読んで以下に分類する。**要約は必ず body と diff_hunk を両方読んでから** 書く (body だけだと対象箇所を誤認することがある)。

| 分類 | 基準 | 対応 |
|---|---|---|
| **accept** | 指摘が妥当で修正すべき | Step 4 の方針に含める |
| **reject** | 誤解・前提の違い・既に別コミットで解決済み | Step 4 で理由付きで skip を提案 |
| **defer** | 妥当だが本 PR のスコープ外 / 後続 PR で扱うべき | Step 4 で「後続 PR で対応」の意図を提案 |

### Step 4: 修正方針をユーザーに提示して承認を得る

**ここで必ず一度止まる**。Step 5 以降は承認を得てから開始する。

以下の表形式で出力:

```
| # | コメント元 | 論点 (1〜2 行) | 分類 | 対応案 |
|---|---|---|---|---|
| 1 | Copilot inline L86 | テスト名と中身が矛盾 (...) | accept | テストを 2 つに分離 |
| 2 | reviewer issue | lockfile 由来の dep 衝突 | defer | PR #N で解消予定と返信方針 |
| 3 | Copilot inline L71 | docstring と schema の乖離 | accept | docstring を弱める |
```

- 修正方針はファイル・関数レベルまで具体化する ("〜あたりを直す" は禁止)
- ユーザーが「この # は reject / defer に変えたい」と言える粒度にする
- 承認前にファイル編集 (Edit/Write) を **絶対に実行しない**

### Step 5: 承認後に修正を適用

承認が得られたら accept 分類のコメントのみ修正する。reject / defer はそのまま残す。

- 修正範囲がシンプルなら 1 コミットにまとめる
- コメント粒度が大きく異なるなら論点ごとに分割コミット (`/commit` の分割方針に従う)
- コミットメッセージは `fix: PR #<N> レビュー指摘を反映 (<短い要約>)` 形式

### Step 6: 検証

コード変更後は必ず以下で確認する:

```bash
mise run check
```

失敗したら原因を突き止めて直す (承認された修正方針の範囲内で)。方針を超える変更が必要なら Step 4 に戻ってユーザーに再確認。

### Step 7: push と結果報告

```bash
git push
```

最後にユーザーに報告する内容:
- 何 # を accept / reject / defer したか
- 何コミット push したか (SHA の短縮 hash)
- reject / defer した分はユーザーがコメントに返信する必要があることを明記
- `mise run check` の結果サマリ

## 注意事項

- **コメント返信はしない**: `gh api .../comments/<id>/replies` は skill から呼ばない。返信の要否・文面はユーザーが手動で判断する
- **承認なしで修正しない**: Step 4 でユーザーが「いいよ」「OK」等を明示するまで Edit/Write ツールを使わない
- **reject/defer も分類として明示する**: 黙って無視するのではなく Step 4 の表に理由付きで載せる
- **対話型ツールは使わない**: `gh pr review` 等のインタラクティブモードは不使用
- bot reviewer (Copilot 等) のコメントも人間レビュアーと同じ扱いで分類する
