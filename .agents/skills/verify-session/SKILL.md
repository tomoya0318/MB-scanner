---
name: verify-session
description: 実装完了後の検証フェーズを fresh な分割ペインで実行する。review.md のタスク固有観点を Opus サブエージェントで現物検証し、条件に応じて native /code-review を併用し、結果を review.md に追記する。start-implementation の spawn-session.sh から `claude "/verify-session <work-dir>"` で起動される。
disable-model-invocation: true
argument-hint: /verify-session <work-dir>（tmp/NNNN_* のパス）
---

# 検証セッション skill

実装を**実装したのとは別の fresh セッション**で検証する（自己正当化バイアスの分離 + main の context を太らせない）。
通常 `start-implementation` の `spawn-session.sh` が分割ペインで起動する。

## 前提・原則

- このセッションは `review.md` の観点で**現物（コード・git 履歴・実行結果）を検証**する。PR 説明・コミットメッセージ・コード内コメントの主張は信用しない。
- 指摘は `file:line` 付き、確信度（高/中/低）を明示。修正案は強制しない。
- 重い観点判断は **Opus サブエージェント**で回す（セッションが Opus なら継承でよいが、load-bearing な観点は明示的に opus を指定）。

## 作業フロー

### Step 1: review.md と差分の把握

```bash
cat <work-dir>/review.md          # 観点 + 推奨起動形
git -C "$(git rev-parse --show-toplevel)" status -sb
git diff --stat                   # 検証対象の差分（必要に応じて main 比較）
```

`review.md` の **「推奨起動形」** と **「観点」** を読む。意図の把握に `plan.md` / `brief.md` を読むのは可（検証者は実装者ではないのでバイアス対象外）。

### Step 2: タスク固有観点の検証（Opus サブエージェント）

`review.md` の観点ごとに、独立した Opus サブエージェントへ委譲する。各サブエージェントは:

- 観点が指す現物を `file:line` で開いて突き合わせる（git blame / git log も使う）
- 「何を・どの現物で・何と照合したか → OK / 要修正」を返す
- 反証的に読む（「合っているはず」ではなく「破れていないか」を探す）

複数観点は並行で投げてよい。

### Step 3: native /code-review の併用（条件付き）

`review.md` の「推奨起動形」に従う。判定ルーブリック（review.md にも記載）:

| 変更の性質 | /code-review |
|---|---|
| 差分なし（ADR/docs-only） | 不要（カスタム観点のみ） |
| docs/コメント/小掃除/純機械移動 | `low` |
| 機械移動 + import 書換 / 中規模 | `medium` |
| ロジック・挙動を含む実装 | `high` |
| 高リスク（過去バグ箇所/契約 drift/挙動変更複数） | `max` + ultra を**推奨提示** |

共通条件:
- **カスタム観点（Step 2）は常に実行**。`/code-review` は**コード差分があるときだけ**。
- `--comment` は **PR が既にあるときだけ**（pre-PR のローカル検証では付けない）。
- `--fix` は**付けない**（先に指摘を見る）。
- **`ultra` は自動起動しない**（課金・user-triggered）。高リスク時は「ultra 推奨」と提示するだけ。

native `/code-review <effort>` はセッションの main-loop モデル（Opus）でレビュー本体が走る。

### Step 4: DoD 再走

```bash
mise run check-arch
mise run typecheck
mise run test            # 変更が一部なら uv run pytest <対象ファイル>
mise run lint-analyzer   # TS を触った場合は typecheck-analyzer / test-analyzer も
```

### Step 5: review.md へ結果を追記

`review.md` の「レビュー結果」節に、既存フォーマットで追記する:

```markdown
### レビュー結果 (YYYY-MM-DD / 使った観点・起動形)

**総合**: 承認可 / 要修正、マージブロッカーの有無、DoD 再走の結果を 1〜2 文。

（要修正あり）
| # | 指摘箇所(file:line) | 内容 | 修正 | 確信度 |

（全 OK）
| 観点 | 確認した証拠(file:line) | 結論 |

**留意点**: 要修正ではないが残した判断を 1 行。
```

### Step 6: 報告

ユーザにこのペインで総合判定を伝える。**要修正がある場合は `/apply-review` を案内**する（修正方針の承認 → 一括対応まで。コメント返信は手動に残す）。

## ヒント

- 検証は「観点を通すための実装の追認」ではなく**反証**。観点ごとに「破れる条件」を先に考える。
- `review.md` に観点が薄い / 推奨起動形が未記入なら、それ自体を総合に記し、観点の不足を指摘する。
