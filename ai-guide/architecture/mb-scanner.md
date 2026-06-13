# mb-scanner (Python 側) アーキテクチャ

Python 側コードベース `mb_scanner/` のアーキテクチャ詳細。共通概念と Python ↔ Node 契約は [`index.md`](index.md) を参照。

---

## アーキテクチャ設計

**feature-first 構成** を採用しています (ADR-0030)。パイプラインの**段 (stage)** — preprocessing → equivalence → pruning — をディレクトリの第一軸とし、1 段 = 1 ディレクトリに機能を凝集させます。技術的役割 (層) で横に切る旧 Clean Architecture 4 層からの移行については ADR-0030 参照。

### 段 (stage) の構成

各段ディレクトリ (`mb_scanner/<段>/`) は同じ部品を持ちます:

- **`cli.py`**: その段の Typer コマンド (例: `check-equivalence` / `prune` / `preprocess-selakovic`)。
- **`gateway.py`**: **Port (Protocol) を先頭に**、Node ランナー subprocess の具象実装 (`NodeRunner*Gateway`) を同居させる。cli は Protocol 型で DI を受け、具象を直接組み立てるのはルートの composition root だけ。
- **`models.py`**: Pydantic BaseModel による入出力モデル (TS 契約の Python ミラー)。
- equivalence のみ **`verdict.py`** (observation からの verdict 導出 + `EquivalenceVerificationUseCase`)、preprocessing のみ **`dataset.py`** (Selakovic dataset の issue 列挙) を追加で持つ。

共通基盤はパッケージルートに置き、各段から共有します:

- **`cli.py`** (ルート): 各段の Typer app を統合する composition root + `main()` エントリポイント。
- **`config.py`**: pydantic-settings (Settings クラス、mb_analyzer 2 フィールド)。
- **`_utils.py`**: CLI 共通ヘルパ (`resolve_workers` 等)。

### 依存ルールの自動検証

`import-linter` で依存方向を自動チェックしています。

```bash
mise run check-arch   # import-linter で independence + forbidden 契約を検証
```

**契約:**
- **independence 契約**: パイプライン段 (`equivalence` / `pruning` / `preprocessing`) は互いに import しない (段間の相互不可侵)。共通基盤 (`mb_scanner._utils` / `config` / `cli`) への依存は段間 import ではないので許可される。
- **forbidden 契約**: 各段の `models.py` (型契約) と `gateway.py` (Protocol + 実装) が `typer` を import していないことを保証 (cli.py は Typer commands なので対象外)。
- 段内の層秩序 (cli → gateway → models の向き) は機械強制せずレビューと慣行に委ねる (ADR-0030 で諦めたもの)。

---

## ディレクトリ構造

```text
mb_scanner/mb_scanner/        # flat layout (src/ 廃止、PR-8)
├── equivalence/              # === 段: 等価性検証 ===
│   ├── cli.py                # check-equivalence / check-equivalence-batch
│   ├── gateway.py            # EquivalenceCheckerPort (Protocol) + NodeRunnerEquivalenceGateway
│   ├── models.py             # EquivalenceInput, EquivalenceCheckResult, Oracle 列挙
│   └── verdict.py            # derive_overall_verdict / derive_verdict_reason + EquivalenceVerificationUseCase
├── pruning/                  # === 段: pruning ===
│   ├── cli.py                # prune / prune-batch
│   ├── gateway.py            # PrunerPort (Protocol) + NodeRunnerPrunerGateway + INTERNAL_KEY_PREFIX
│   └── models.py             # PruningInput, PruningResult, Placeholder
├── preprocessing/            # === 段: 前処理 ===
│   ├── cli.py                # preprocess-selakovic / preprocess-selakovic-batch
│   ├── gateway.py            # PreprocessorPort (Protocol) + NodeRunnerPreprocessorGateway
│   ├── models.py             # IssueResult 階層 (ADR-0024)
│   └── dataset.py            # scan_selakovic_dataset (issue 列挙)
│
├── cli.py                    # === 共通基盤: 各段の Typer app を統合する composition root + main() ===
├── config.py                 # pydantic-settings (Settings クラス、mb_analyzer 2 フィールド)
└── _utils.py                 # CLI 共通ヘルパ (resolve_workers 等)

mb_scanner/tests/             # テスト (段構造をミラー)
├── equivalence/              # test_cli / test_gateway(_batch) / test_models / test_verdict / test_selakovic_fixtures
├── pruning/                  # test_cli / test_gateway(_batch) / test_models
├── preprocessing/            # test_gateway(_batch) / test_models
└── fixtures/selakovic/       # 等価性検証の Selakovic 10 パターン fixture
```

---

## データフロー

```
data/selakovic-2016-issues (submodule)
  → mbs preprocess-selakovic-batch → extracted.jsonl     (Python CLI → node cli.js)
  → research: build_equiv_input.py → equiv-input.jsonl
  → mbs check-equivalence-batch    → equiv-results.jsonl
  → research: build_prune_input.py → prune-input.jsonl
  → mbs prune-batch                → prune-results.jsonl
  → research: summarize.py / funnel.py / normalize_pattern.py
```

各段の Python 側はいずれも「JSONL ロード → Node ランナー (`mb-analyzer/dist/cli.js`) subprocess 起動 → 結果を段の `models.py` 型に変換」の薄いオーケストレーション。

---

## 新機能追加ガイド

feature-first 構成 (1 段 = 1 ディレクトリ) を遵守すること。段は互いに import しない (independence)。

### 1. 既存段に CLI コマンドを追加する

1. 対象段の `mb_scanner/<段>/cli.py` にコマンドを追加する (`Typer` でコマンドと引数を定義)
2. CLI 内で Protocol 型で DI を受け、具象 gateway を組み立てて実行する
3. 新しい段の cli を増やした場合はルート `mb_scanner/cli.py` (composition root) に register する

### 2. 新しいモデルの追加

1. 対象段の `mb_scanner/<段>/models.py` に Pydantic BaseModel を定義する
2. 外部連携が必要な場合は同段 `gateway.py` の**先頭**に Protocol を定義する (実装と同居)

### 3. 新しいパイプライン段の追加 (Node ランナー連携)

1. `mb-analyzer/src/cli/` 側にサブコマンドを追加する (TS 側ドキュメント参照)
2. `mb_scanner/<新段>/` ディレクトリを作り、`models.py` (TS 契約の Python ミラー) / `gateway.py` (Protocol を先頭に NodeRunner gateway 実装を同居、subprocess 起動 + エラー写像) / `cli.py` を置く
3. ルート `mb_scanner/cli.py` に新段の Typer app を register する
4. `import-linter` の independence 契約 (`mb_scanner/pyproject.toml`) の `modules` に新段を追加する

### 4. 並列バッチ処理の追加

- 並列化は **Python 側 `ThreadPoolExecutor`** で実施 (subprocess 起動は I/O バウンドなので GIL 解放される)
- ルート `mb_scanner/_utils.py` の `resolve_workers(workers)` で `workers=-1 → os.cpu_count() or 1` を統一解決
- バッチサイズの auto 決定は `max(10, ceil(total / actual_workers))` を既存パターンに合わせる
- 進捗は stderr に `[progress] N/total batches done` 形式で出力 (`rich` / `tqdm` は導入しない、nohup 前提)

---

## コーディング規約

### 型定義の原則

`Any` 型の使用は厳禁。

| ユースケース | 推奨する型 | 理由 |
| :--- | :--- | :--- |
| **外部入力の読み込み** | `Pydantic` | 厳密なバリデーションとパース機能が必要なため |
| **設定オブジェクト** | `Pydantic` | デフォルト値の管理や環境変数の読み込みのため |
| **JSON 出力** | `Pydantic` | `model_dump_json()` によるシリアライズとスキーマ生成を活用するため |
| **関数の内部戻り値** | `TypedDict` | ランタイムオーバーヘッドがなく軽量なため |
| **内部データ構造** | `TypedDict` | バリデーション不要で型ヒントのみ必要な場合 |

モデルの配置ルール:
- **モデル (Pydantic BaseModel)**: 各段の `mb_scanner/<段>/models.py` に配置する。dataclass は使わない
- **TypedDict**: 原則として使用するモジュール内に定義する。同段内の複数モジュールで再利用する場合のみ `models.py` へ移動する

### ファイル形式の選択

**JSON を選択すべき場合:**
- データが階層構造を持つ場合（例: IssueResult、抽出結果）
- 型情報（文字列/数値/真偽値/null）を区別して保存したい場合
- Pydantic モデルをそのままダンプしたい場合

**CSV を選択すべき場合:**
- Excel やスプレッドシートでの閲覧・分析が主目的の場合
- ネストのない単純なテーブル形式のデータ

### 命名規則

- **`Project`**: GitHub リポジトリを表す用語（`Repository` は DB パターン用語のため混同回避。GitHub/DB 系コードは legacy へ切り出し済みだが用語は維持）
- **`Gateway`**: 外部システム連携アダプター
- **`Port`**: 各段 `gateway.py` 先頭の Protocol (実装と同居)

### 静的解析ツール

- **Linter/Formatter**: `ruff` (`mise run fix` で実行)
- **Type Checker**: `pyright` (`mise run typecheck` で実行)
- **Architecture**: `import-linter` (`mise run check-arch` で実行)

---

## データベース

本体にデータベースは無い。旧 SQLite + SQLAlchemy の設計 (projects / topics / project_topics) は [MB-scanner-legacy](https://github.com/tomoya0318/MB-scanner-legacy) を参照。データ実体 `data/mb_scanner.db` はファイルとして残置している (本体コードからの参照は無い)。
