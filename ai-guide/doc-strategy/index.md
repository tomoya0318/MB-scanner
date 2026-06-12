# ドキュメント戦略

`ai-guide/` とコード隣接ドキュメントの配置ルール。**「書きたい内容を、どこに書くか」** だけを扱い、内容そのものは扱わない。

言語固有 (TS / Python) で表記が分かれる場合は将来 `mb-analyzer.md` / `mb-scanner.md` を分割する。現状は共通ルールのみで成立しているため index.md 単独。

---

## ai-guide 4 軸の住み分け

`ai-guide/` は用途別に 4 軸で構成する。書きたい内容の **語尾** で振り分け、重複を避ける。

| 文書 | 性質 | 文体 | 想定読者 |
|---|---|---|---|
| [`architecture/`](../architecture/index.md) | **Contract** — 〜すべき / 〜禁止 / 〜と一致 | 表・条件文 | `check-architecture` skill, レビュー時の自分 |
| [`quality-check/`](../quality-check/index.md) | **Process** — 〜を確認する / 〜で検証する | 手順書 | `check-tests` skill, QA |
| [`code-map.md`](../code-map.md) | **Reference** — 〜する仕組み / 〜のため〜 | 物語・図・データフロー | 論文執筆、onboarding |
| [`adr/`](../adr/README.md) | **Decisions** — 〜を採用し、〜を却下した | Context / 選択肢 / 決定 / トリガー | 設計判断を見直す人、履歴を追いたい人 |

### 各軸の役割境界

- **architecture/**: 静的解析で機械強制したいルール、層境界、契約。「これを守らないと違反」と言える内容のみ。
- **quality-check/**: 検証手順 (lint / typecheck / test / arch check のコマンドと CI 連携)。
- **code-map.md**: 全体ワークフローと各モジュールの**役割サマリ**。**ファイル単位の詳細は in-tree README に委譲** (drift 防止)。
- **adr/**: 採用判断の根拠と却下した選択肢。1 ADR = 1 判断。現行契約は必ず `architecture/` 側に反映する (ADR は履歴扱い)。

---

## in-tree README (ディレクトリ単位)

`ai-guide/` 4 軸とは別レイヤとして、**コードツリー内の各ディレクトリに `README.md` を配置** することがある。

### 配置基準

| 条件 | README を置くか |
|---|---|
| ディレクトリ内ファイル 5 件以上、または subdirectory を持つ | **置く** |
| ディレクトリ内ファイル 4 件以下、subdirectory なし | **置かない** (親ディレクトリの README に記述) |

### 役割

| in-tree README が担う | code-map.md との違い |
|---|---|
| ディレクトリ内**各ファイルの責務** | code-map.md は「モジュール単位の役割」までで止め、ファイル単位は降りない |
| ディレクトリ内**ファイル間の依存方向** | code-map.md は「モジュール間データフロー」まで |
| 関連 ADR の索引 (このディレクトリの判断履歴) | code-map.md は ADR を本文中で個別参照するのみ |

### 参照方向は一方向 (code-map → README)

- **OK**: `code-map.md` から各 in-tree README へのポインタ
- **NG**: in-tree README から `code-map.md` / `current-research.md` 等の **上位 / 流動的なドキュメント** への参照

理由: code-map.md と current-research.md は実装意味論や研究方針に応じて頻繁に更新されるのに対し、README はディレクトリ churn でしか更新されない。**頻繁に変わる側 → 安定している側** へのポインタを許し、逆向きを禁じることで、README が drift するリスクを排除する。

README は **自己完結** させる: ファイル責務・依存方向・関連 ADR のみで意味が通り、上位文書を読まなくてもディレクトリの全体像が把握できる粒度を保つ。

### 内容テンプレート

```markdown
# <module-name>

<このディレクトリが担う 1〜3 行の役割>

## ファイル index
| file | 役割 | 主な依存 |
|---|---|---|
| ... | ... | ... |

## 依存方向
<ASCII tree か、簡単なグラフ>

## 関連 ADR
- ADR-NNNN: <タイトル>
- ...
```

### 更新トリガー

**ディレクトリ内のファイル churn** が起きたときのみ。

- ファイル追加 / リネーム / 削除
- 役割の根本的な変更 (実装の細部変更では更新不要)

→ 実装の日々の変更で README が drift しないよう、**書く粒度を「役割と依存」止まり** にする (関数シグネチャや実装詳細は書かない)。

### スコープ

現状の MB-Scanner で in-tree README を置くべきディレクトリ:

- `mb-analyzer/src/pruning/` (common/ = dataset 非依存 {engine,candidates,rules/,ast/} + selakovic/ = checkEquivalence を bind する adapter)
- `mb-analyzer/src/equivalence-checker/` (common/{sandbox/{executors,capture,transforms},comparison/oracles,serializer} + selakovic/{checker,oracle-routing,profiles})
- `mb-analyzer/src/preprocessing/` (common/ = Tier 1 + selakovic/{io,decompose,route,assemble,pipeline} = Tier 2)
- `mb-analyzer/src/cli/` (サブコマンド entry 群 + 入出力契約 — ただし入出力データの意味論はモジュール README が一次ソース、CLI README は CLI 固有の引数/stderr/終了コードのみ)

将来 mb_scanner/ 側でも対象が出れば追加。subdirectory レベル (`pruning/common/` / `equivalence-checker/common/comparison/` / `preprocessing/selakovic/io/` 等) は親 README で記述するため不要。

---

## コメントとドキュメントの層分離

コードとドキュメントに残す情報は「読み手が何をしたいか」で層を分ける。

| 読み手の目的 | 置き場所 |
|---|---|
| 関数を **使う** (契約・挙動を知る) | JSDoc (TS) / docstring (Python) |
| **自明でない局所的な工夫** を理解する | ソース内 `//` / `#` コメント |
| 採用判断を **変える** (却下した選択肢を見直す) | [`adr/`](../adr/README.md) |
| 日付軸のマイルストーン | `TODO.md` |

**判定基準**: 「読み手は *使う* 人か、*変える* 人か」。使う人向けなら JSDoc / docstring、変える人向けなら ADR。

### 具体原則

- **JSDoc / docstring は契約のみ**: 不変条件・前提・失敗条件を書く。採用理由や却下した選択肢は書かない (それは ADR の仕事)
- **`//` / `#` は自明でない時だけ**: 関数名とシグネチャから読み取れる内容は書かない
- **section divider コメント** (例: `// --- 内部ヘルパ ---`) は原則避ける。export 境界や関数分割で区切りは自明
- **ADR への参照**: 採用判断を示すコメントは `// 判断: ai-guide/adr/NNNN-xxx.md` 形式で 1 行 (理由や却下案は ADR 側に)。契約文 (JSDoc / docstring / 説明コメント) 中のポインタは `ADR-NNNN` / `ADR-NNNN §x` 形式の略記を許容する (括弧の有無は問わない)。いずれも `ADR-` prefix 付き番号で書く (裸番号・行番号参照は不可)
- **移行履歴 / 変更経緯はコードに残さない**: 「旧 X から移管」「ADR-NNNN で変更」のような change-log 風コメントは書かない (履歴は git log と ADR 側で追える)
- **言葉使い**: 具体的に (「ms オーダで重い」のような未計測の誇張は避ける、計測値がなければ定性的に書く)

言語固有の書き方は `architecture/mb-scanner.md` / `architecture/mb-analyzer.md` を参照。

---

## 矛盾時の優先順位

```
architecture/  >  quality-check/  >  code-map.md / in-tree README  >  adr/
契約             検証手順           リファレンス                    履歴
```

- **契約 (architecture) が最優先**。code-map.md / README の記述が architecture/ と食い違う場合は architecture/ を信じる。
- **ADR は履歴扱い**: 採用判断の根拠を残すだけで、現行契約は必ず architecture/ に反映する。ADR と現行契約が食い違う場合 (= 過去判断が覆っている可能性) は新規 ADR を起票して旧 ADR を `superseded by ADR-NNNN` にする。
- **drift 防止**: 同じ内容を複数文書に書かない。**1 軸 = 1 出典** を守り、他からはリンクで参照する。
