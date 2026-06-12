# MB-Scanner

MB-Scanner は、マイクロベンチマーク由来の JavaScript パフォーマンスパターンを導出する研究実装です。Selakovic dataset の前処理 → 動的等価性検証 (vm サンドボックス + 4 オラクル) → Pruning (核抽出に向けた縮約) → 条件抽出・同値分割テスト → ts-eslint ルール生成、というパイプラインを目指して開発しています。

- **Python 側 (`mb_scanner/`)**: 薄いオーケストレータ。JSONL のロード・並列バッチ実行・結果集約と CLI (`mbs`) を担う
- **TypeScript 側 (`mb-analyzer/`)**: 解析本体。AST 解析・サンドボックス実行を `dist/cli.js` の subprocess として提供する

> 旧 MB-search 時代の「GitHub リポジトリ検索 + CodeQL バッチ実行」プラットフォームは [MB-scanner-legacy](https://github.com/tomoya0318/MB-scanner-legacy) へ切り出して凍結しました (2026-06)。切り出し直前のスナップショットは本リポジトリのタグ `archive/pre-extraction-2026-06` です。

## 研究パイプラインとデータフロー

```
data/selakovic-2016-issues (submodule)
  → mbs preprocess-selakovic-batch → extracted.jsonl     (Python CLI → node cli.js)
  → research: build_equiv_input.py → equiv-input.jsonl
  → mbs check-equivalence-batch    → equiv-results.jsonl
  → research: build_prune_input.py → prune-input.jsonl
  → mbs prune-batch                → prune-results.jsonl
  → research: summarize.py / funnel.py / normalize_pattern.py
```

`research/` は研究のスパイク・集計スクリプト群 (mb_scanner 非依存のスタンドアロン)。研究計画は `ai-guide/current-research.md` を参照。

## 前提条件

**必要なのは mise だけ** です。uv / node / pnpm は mise が `.mise.toml` から自動でインストールします。

```bash
# mise のインストール（未導入の場合）
curl https://mise.run | sh

# mise を有効化（シェルに合わせて）
eval "$(~/.local/bin/mise activate bash)"   # or zsh / fish
```

## セットアップ

```bash
git clone https://github.com/tomoya0318/MB-scanner.git
cd MB-scanner

mise install            # uv / node / pnpm を .mise.toml から自動インストール
mise run setup          # submodule 更新 + Python 依存 + mb-analyzer 依存
mise run build-analyzer # TS 側 CLI バンドル dist/cli.js を生成

# Selakovic dataset の vendor deps (初回、または dataset 更新後のみ。重い)
mise run setup-dataset
```

環境変数は通常不要です。Node や CLI バンドルの場所を変えたい場合のみ `.env.sample` をコピーして設定します。

## 基本的な使い方

```bash
# Selakovic dataset の前処理（バッチ）
mbs preprocess-selakovic-batch --dataset data/selakovic-2016-issues --output extracted.jsonl

# 等価性検証（単発）
mbs check-equivalence \
    --setup 'const x = -3;' \
    --slow 'x % 2' \
    --fast 'x & 1'
# exit 1 で not_equal を返す (Selakovic パターン 8 の負数反例)

# 等価性検証（バッチ: JSONL 入出力、ThreadPoolExecutor による並列化）
mbs check-equivalence-batch \
    --input equiv-input.jsonl \
    --output equiv-results.jsonl \
    --workers -1        # -1 で os.cpu_count() を使用

# Pruning（バッチ）
mbs prune-batch --input prune-input.jsonl --output prune-results.jsonl

# ヘルプ
mbs --help
```

## 開発

```bash
# 全チェック一括実行（Lint + 型チェック + テスト + アーキテクチャ検証、両言語）
mise run check

# 個別実行
mise run test              # Python: pytest（integration は build-analyzer 後に green になる）
mise run lint              # Python: ruff
mise run typecheck         # Python: pyright (strict)
mise run check-arch        # Python: import-linter
mise run test-analyzer     # TS: vitest
mise run typecheck-analyzer # TS: tsc --noEmit
mise run lint-analyzer     # TS: ESLint（依存方向検査込み）

# コードフォーマット + 自動修正
mise run fix
```

アーキテクチャは Clean Architecture 4 層 (Python) + ESLint ゾーン構造 (TS)。詳細は [`ai-guide/architecture/`](ai-guide/architecture/index.md) を参照。

## プロジェクト構造

```
mb_scanner/src/mb_scanner/    # Python 側（薄いオーケストレータ）
├── domain/
│   ├── entities/             # equivalence / preprocessing / pruning（Pydantic、TS 契約のミラー）
│   └── ports/                # equivalence_checker / preprocessor / pruner（Protocol）
├── use_cases/                # equivalence_verification / preprocessing/selakovic / pruning
├── adapters/
│   ├── cli/                  # Typer CLI（composition root）
│   └── gateways/             # Node ランナー subprocess 実装
└── infrastructure/           # config（pydantic-settings）

mb-analyzer/                  # TypeScript 側（解析本体）
├── src/
│   ├── shared/               # 共通型（Verdict/Oracle/EquivalenceInput 等、Python と JSON 互換）
│   ├── preprocessing/        # Selakovic dataset 前処理
│   ├── equivalence-checker/  # 等価性検証器（sandbox + 4 oracle + checker）
│   ├── pruning/              # Pruning
│   └── cli/                  # composition root（サブコマンド）
└── dist/cli.js               # esbuild で生成する 1 ファイル CLI（mise run build-analyzer）

research/                     # 研究スパイク・集計スクリプト（スタンドアロン）
data/selakovic-2016-issues    # データセット (git submodule)
tests/                        # Python テスト（CA 構造をミラー、integration 含む）
ai-guide/                     # エージェント向けガイド（architecture / quality-check / 研究計画）
```

## Docker

- `Dockerfile.dev` — 日常開発用 (mise 同梱)。`mise run docker:build && mise run docker:up && mise run docker:shell`
- `Dockerfile.prod` — 再現実験用 multi-stage (Python venv + Node ランタイム + mb-analyzer/dist 焼き込み)。`mise run docker:archive:build`
