---
name: generate-approach-spec
description: in-tree README またはアプローチ仕様書を、コード現物 + 関連 ADR + research notes から file:line 引用付きで生成する (ADR-0029 の生成型 Reference 軸)。「mb-analyzer/src/preprocessing の README を再生成して」「pruning アプローチの仕様書を作って」のように Reference 文書が必要になったとき、ディレクトリ churn (ファイル追加・リネーム・削除や役割変更) の後に README を最新化したいときに使う。生成物は手編集禁止のため、README の修正依頼にもこの skill の再生成で対応する。
---

# Reference 文書の生成 (ADR-0029)

ai-guide の Reference 軸は維持型をやめ、必要時に生成する (判断: `ai-guide/adr/0029-generated-reference-docs.md`)。
この skill はスコープ引数で 2 種類の出力を切り替える:

| スコープ引数 | 出力 | 置き場 |
|---|---|---|
| ディレクトリパス (例: `mb-analyzer/src/preprocessing`) | in-tree README | `<dir>/README.md` — スナップショットとして常設コミット |
| アプローチ名 (例: `pruning アプローチ`) | アプローチ仕様書 | ユーザー指定先 (既定: `tmp/spec-<slug>.md`。常設コミットの指示があればそれに従う) |

## 0. 前提確認

1. `git status` が clean であることを確認する。dirty だとコミット印が生成内容と一致しなくなるため、
   生成対象に関わる未コミット変更があれば中断してユーザーに確認する。
2. コミット印を取得する: `git rev-parse --short HEAD` と当日日付。

## 1. 読込

1. スコープ内の **全ソースファイル** を読む。README ならそのディレクトリ配下全部、アプローチ仕様書なら
   アプローチを構成するモジュール群 (TS 側 + 対応する `mb_scanner/` 側)。JSON 契約に触れる文書では
   `mb-analyzer/src/contracts/*.ts` と Python エンティティも対象に含める。
2. `ai-guide/adr/README.md` の索引から対象領域が一致する ADR を特定し、本文を読む
   (superseded のものは現行の後継側を正とする)。
3. アプローチ仕様書のみ: `ai-guide/current-research.md` の該当節と `research/<approach>/notes/` の保存値。
4. 旧生成物 (既存 README 等) は **構成の参考にしてよいが記述の根拠にしない**。すべての主張を
   コード現物か ADR から再構成する (旧文書からの転記は drift を持ち込む)。

## 2. 生成

### ヘッダ (必須)

タイトル直下に印字する:

```markdown
> 生成物 — 手編集禁止 (ADR-0029)。再生成: `/generate-approach-spec <スコープ>`
> 生成時コミット: `<short-hash>` (<YYYY-MM-DD>)
```

### 内容規約

- 検証可能な記述には `file.ts:NN` 形式の file:line 引用を付ける (引用は手順 3 の検証単位になる)。
- **in-tree README**: ディレクトリの役割 (1〜3 行) / ファイル index 表 (file・役割・主な依存) /
  依存方向 / モジュール固有の契約要約 (CLI なら argv・stdin・stdout・stderr・終了コード) / 関連 ADR の索引。
  粒度は「役割・依存・契約」止まりにし、関数シグネチャの転記や実装詳細は書かない。
- **アプローチ仕様書**: アプローチの目的・入出力契約・処理フロー・設計判断 (ADR への参照) ・既知の限界。
- 参照方向: `current-research.md` 等の上位・流動的な文書への参照は **禁止** (同層の README・ADR への
  参照は可)。文書は自己完結させる。
- 実測値は README に書かない (恒久の家は `research/<approach>/notes/`)。仕様書に載せる場合は手順 4 に従う。
- ADR 参照は `ADR-NNNN` 表記 (裸番号・行番号参照は不可)。

## 3. 検証パス (必須)

生成しただけでは終わらない。**新しいコンテキストの subagent** (生成時の思い込みを引き継がない) に
以下を検証させ、指摘ゼロになるまで修正→再検証を繰り返す:

1. 生成文書中の全 file:line 引用を開き、引用先が記述内容と一致するか突き合わせる。
2. 引用のない検証可能な記述 (フィールド名・enum 値・終了コード・デフォルト値・ファイル一覧・依存方向) を
   grep / 現物読みで照合する。
3. スコープ内に文書が言及していないファイル・サブコマンド・契約フィールドが残っていないか (網羅性) を確認する。

## 4. 実測値の二段運用 (ADR-0029)

仕様書に実測値が必要なときは mode を明示して使い分ける:

- **mode=paper (論文モード)**: `research/<approach>/code/` の再走スクリプトを、最新の JSON 契約との
  整合を確認した上で再実行し、その値のみを使う。
- **mode=overview (理解モード)**: `research/<approach>/notes/` の保存値を使ってよいが、
  notes 側のコミット印 (実行コミット・コマンド・日付) の併記を必須とする。コミット印のない保存値は使わない。
