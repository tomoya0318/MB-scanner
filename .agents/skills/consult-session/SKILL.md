---
name: consult-session
description: ユーザと同期的に意見交換するための sub-session を分割ペインで実行する。実装前の未決事項の確認（mode=confirm）や、実装後の変更説明 QA（mode=qa）を main セッションから切り離して行い、結論だけを consult-*.md に書き戻す（main の context を太らせない）。start-implementation の spawn-session.sh から `claude "/consult-session <arg> [mode]"` で起動される。
disable-model-invocation: true
argument-hint: /consult-session <work-dir または handoff> [confirm|qa]
---

# 相談セッション skill

ユーザとの同期会話を **main とは別の Claude セッション**で行う。目的は main の context／トークンを太らせないこと（ユーザ理解の補助や、main の理解だけでは決められない確認は、修正対象でない情報まで main に積みがちなので分離する）。
通常 `start-implementation` の `spawn-session.sh` が分割ペインで起動する。

## モード

- **confirm（実装前）**: `brief.md` の未決事項のうち、ユーザ確認が必要 & main の理解だけでは決められない論点を同期で詰める。
- **qa（実装後）**: 変更内容（diff / review.md）をユーザに説明し、納得するまで質問に答える。

mode 省略時は handoff / work-dir の内容から判断（未決事項があれば confirm、実装済みなら qa）。

## 作業フロー

### Step 1: 文脈の取り込み（安価に seed）

引数の `<work-dir>` または handoff ファイルを起点に、必要なものだけ読む:

- confirm: `brief.md`（特に「未決事項」「実装の核」）+ 関連コードの該当箇所
- qa: `git diff` / `review.md` / `brief.md` + 該当コード

main の会話履歴は引き継がない。**ファイルから必要分だけ読む**のがこのセッションの利点。

### Step 2: 同期会話

ユーザとこのペインで対話する。

- **confirm**: 各論点について選択肢・トレードオフ・推奨を提示し、ユーザの判断を引き出す。曖昧なら確定するまで掘る。
- **qa**: 変更の意図・影響・残リスクを噛み砕いて説明し、質問に答える。ユーザが「分かった」となるまで。

### Step 3: 結論の書き出し（main が読む唯一の出力）

会話が決着したら、`<work-dir>/consult-<topic>.md` に**結論だけ**を簡潔に書く（会話全文は書かない）:

```markdown
# consult: <topic> (<confirm|qa> / YYYY-MM-DD)

## 論点 / 質問
<何を相談したか>

## 結論
<決まったこと / 回答の要点>

## main への申し送り
- <plan.md / brief.md / 実装に反映すべきアクション>
```

### Step 4: 終了案内

ユーザに「main ペインに戻ってください（prefix + o / 矢印）。main がこの結論を読みます」と伝える。

## ヒント

- このセッションの成果は**結論ファイルだけ**。冗長な議論ログを残さない（main が読むため）。
- confirm で新たな未解明が出たら、それも結論ファイルに「未解決として残す論点」として明記する。
