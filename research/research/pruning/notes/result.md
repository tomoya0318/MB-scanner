# pruning 結果検証: 結果

スナップショット: main @ `17bb101`。手法は [`method.md`](method.md)。
再現: `code/` で `python stage_funnel.py`、`python match_regex.py`、`node match_ast.mjs`。

## 結論 (TL;DR)

- **形 (shape) は静的手法で検出できる**。pruned `pattern_code` を持つ 8/10 パターン全てで、before-shape を
  regex・AST 双方が **loose で 100% 検出** (8/8)。**regex と AST は検出力が同等**だった。
- うち **5/8 は骨格 (strict) に形が残り**、3/8 (P2 `substr(i,1)` / P5 `substr(0,2)` / P10 `slice.call(args).join`)
  は pruning がオペランドを placeholder に抽象化したため **展開しないと形が出ない (loose のみ)**。
- 残り 2 パターンは pattern_code が無く形検証不可。**段階分析で落ちどころを特定**: P4 は射影段
  (equiv-input 非到達)、P7 は pruning 段 (片方 pruning error / 片方 equiv error)。

## 1. 段階別 funnel: 10 パターンの issue がどこで落ちるか

| P | issue | 抽出 | 射影 | verdict | pruned | 脱落/到達段 |
|---|-------|:--:|:--:|:------:|:--:|------|
| P1 | 7012 (Angular) | ✓4 | ✓ | equal | ✓ | **pruned** |
| P1 | 7759_3 (Angular) | ✓4 | ✓ | equal | ✓ | **pruned** |
| P1 | 11338 (Ember) | ✓2 | ✓ | equal | ✓ | **pruned** |
| P1 | 1222 (Underscore) | ✓2 | ✓ | equal | ✓ | **pruned** |
| P1 | 1223 (Underscore) | ✓2 | ✗ | - | - | 射影: change-not-exercised |
| P1 | 1224 (Underscore) | ✓2 | ✓ | not_equal | - | 等価: not_equal |
| P2 | 136b (Ejs) | ✓2 | ✓ | equal | ✓ | **pruned** |
| P3 | 347_1 (U.string) | ✓3 | ✓ | equal | ✓ | **pruned** |
| P4 | 4457 (Angular) | ✓8 | ✗ | - | - | 射影: change-not-exercised×5, angular-wrapper-skip×2 |
| P5 | 5457 (Angular) | ✓4 | ✓ | equal | ✓ | **pruned** |
| P6 | 39 (Underscore) | ✓2 | ✓ | equal | ✓ | **pruned** |
| P7 | 7735 (Angular) | ✓4 | ✓ | equal | err | pruning: equal だが pruning error |
| P7 | 701 (Mocha) | ✓2 | ✓ | error | - | 等価: error |
| P8 | 4359 (Angular) | ✓3 | ✓ | equal | ✓ | **pruned** |
| P9 | 28 (Chalk) | ✓2 | ✓ | equal | ✓ | **pruned** |
| P10 | 27a (Chalk) | ✓2 | ✓ | equal | ✓ | **pruned** |

### パターン別サマリ (16 issue 中 11 が pruned 到達)

| P | パターン | issue | pruned | 主な脱落段 |
|---|------|----:|----:|------|
| P1 | for-in → Object.keys/for | 6 | 4 | 射影×1 (change-not-exercised), 等価×1 (not_equal) |
| P2 | substr(i,1) → str[i] | 1 | 1 | - |
| P3 | String(v) → ''+v | 1 | 1 | - |
| P4 | .html('') → .empty() | 1 | **0** | **射影×1** (change-not-exercised / angular-wrapper-skip) |
| P5 | substr(0,2) → charAt | 1 | 1 | - |
| P6 | split.join → replace | 1 | 1 | - |
| P7 | toString.call → instanceof | 2 | **0** | **pruning×1 (error), 等価×1 (error)** |
| P8 | x%2 → x&1 | 1 | 1 | - |
| P9 | reduce → for | 1 | 1 | - |
| P10 | slice.call(args).join | 1 | 1 | - |

**脱落の構造**: 射影段 (P1 1223 / P4 4457) は workload が変更箇所を実行しない (change-not-exercised) か
angular stmt skip。等価段 (P1 1224 / P7 701) は not_equal/error。pruning 段 (P7 7735) は equal だが
pruning error (前報告の `$BODY$` 系)。

## 2. 形検出マトリクス (pruned issue を OR 集約)

| P | パターン | pruned | regex strict | regex loose | AST strict | AST loose |
|---|------|----:|:--:|:--:|:--:|:--:|
| P1 | for-in | 4 | ✅ | ✅ | ✅ | ✅ |
| P2 | substr(i,1) | 1 | ❌ | ✅ | ❌ | ✅ |
| P3 | String(v) | 1 | ✅ | ✅ | ✅ | ✅ |
| P4 | .html('') | 0 | — | — | — | — |
| P5 | substr(0,2) | 1 | ✅ | ✅ | ✅ | ✅ |
| P6 | split.join | 1 | ✅ | ✅ | ✅ | ✅ |
| P7 | toString.call | 0 | — | — | — | — |
| P8 | x%2 | 1 | ✅ | ✅ | ✅ | ✅ |
| P9 | reduce | 1 | ✅ | ✅ | ✅ | ✅ |
| P10 | slice.call(args).join | 1 | ❌ | ✅ | ❌ | ✅ |

> 上表は **リテラル保護ルール適用後の canonical** (`MB_PRUNE_PROTECT_DIFF_LITERALS=1`) での再測定値
> (2026-05-27, [`spike-literal-impact.md`](spike-literal-impact.md))。

- **loose: 8/8 検出** (regex・AST 完全一致)。形は必ず pruning 出力内に存在する。
- **strict: 6/8** (P1,P3,**P5**,P6,P8,P9)。**P5 はリテラル保護で `substr(0, 2)` が骨格に出るようになり
  strict ❌→✅ に改善** (旧 baseline=リテラル抽象化ありでは strict 5/8)。
- 残る strict ❌ は P2/P10。これは**シグネチャが文/式まるごと placeholder 化**されているためで
  (P2: substr 呼びを含む statement が wildcard、P10: `slice.call(arguments).join` 式が wildcard)、
  リテラル問題ではない (loose ✅)。
- wrap 分析 (`tmp/0048_full-rerun-17bb101/`) は **50/50 で wrap 100% を維持** (リテラルが skeleton へ移っても
  変更領域の捕捉は不変)。

## 3. regex vs AST tree-match の比較

| 観点 | regex (Backend A) | AST tree-match (Backend B) |
|------|------|------|
| 本データでの検出 | strict 6/8・loose 8/8 | **同一** (strict 6/8・loose 8/8) |
| 精度 (文字列内コード誤検出) | 当たりうる | 構造で除外でき有利 (※本集合では差は顕在化せず) |
| 堅牢性 (parse 不能入力) | テキストなので強い | parse 必須。フル展開が壊れる例 (EJS 136b `};else if`) では取り逃す → **valid 断片で救済が必要** |
| 表現力 (入れ子・引数値) | 限定的 (P5 の引数 0,2、P10 のチェーンは正規表現が長大・脆い) | 自然 (`substr` の args[0]=0,args[1]=2、`.join`⊃`slice.call(arguments)` を素直に書ける) |

**結論**: **形だけの検出なら regex でも AST でも到達可能**で、この 10 パターン (全て局所構文形) では検出力に差は出なかった。
ただし P5/P10 のような**引数値・チェーン構造に依存する形は AST の方が定義が素直で堅い**。一方フル展開が
parse 不能な candidate (EJS 等) では AST が脆く、断片パースのフォールバックが要る。

→ 「形が抜けているか」の検証目的では **regex で十分**。将来 mb_scanner 本体にパターン検出を組み込み、
誤検出を抑えて引数・構造条件まで効かせたいなら **AST tree-match が適切**。
いずれも **caching/hoisting 等の関係的最適化 (10 パターン外) には届かない** (前報告どおり、それは
before↔after の差分=wrap 系でしか取れない)。

## 成果物

- `code/pattern_map.py` (10 パターン定義 + issue 対応)
- `code/stage_funnel.py` (段階分析)
- `code/match_regex.py` / `code/match_ast.mjs` (2 バックエンド) + `shape-targets.json` / `ast-match.json`
