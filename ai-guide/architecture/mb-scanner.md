# mb-scanner (Python 側) アーキテクチャ

Python 側コードベース `mb_scanner/` のアーキテクチャ詳細。共通概念と Python ↔ Node 契約は [`index.md`](index.md) を参照。

---

## アーキテクチャ設計

**実用的 Clean Architecture (Pragmatic CA)** を採用しています。依存の方向は常に内側に向かい、内側は外側を知りません。

### レイヤー構造

```
infrastructure（最外層）→ adapters → use_cases → domain（最内層）
  依存は常に内側に向かう。内側は外側を知らない。
```

1. **Domain 層** (`mb_scanner/domain/`)
   - ドメインモデル (Pydantic BaseModel) とポート (Protocol) を定義
   - 許可する外部依存は `pydantic` のみ。`typer` は禁止
2. **Use Cases 層** (`mb_scanner/use_cases/`)
   - ビジネスロジックを集約。Protocol 経由で依存注入 (DI) を受ける
   - domain にのみ依存し、具象アダプターを直接 import しない
3. **Adapters 層** (`mb_scanner/adapters/`)
   - 入力アダプター (CLI) と出力アダプター (gateways)
   - CLI は **composition root** として依存の組み立てを担当
   - domain + use_cases に依存。infrastructure へのアクセスも許可 (CLI での DI 組み立てのため)
4. **Infrastructure 層** (`mb_scanner/infrastructure/`)
   - フレームワーク・ドライバー層。設定 (pydantic-settings)

### 依存ルールの自動検証

`import-linter` で依存方向を自動チェックしています。

```bash
mise run check-arch   # import-linter でレイヤー契約を検証
```

**契約:**
- **レイヤー契約**: `infrastructure → adapters → use_cases → domain` の順のみ許可
- **ドメイン禁止契約**: domain 層が `typer` を import していないことを保証
- **例外**: `adapters → infrastructure` は `ignore_imports` で許可 (CLI=composition root のため)

---

## ディレクトリ構造

```text
mb_scanner/
├── domain/                   # === Entities 層（最内層）===
│   ├── entities/             # Pydantic BaseModel によるドメインモデル
│   │   ├── equivalence.py    # EquivalenceInput, EquivalenceCheckResult, Oracle 列挙
│   │   ├── preprocessing.py  # IssueResult 階層 (ADR-0024)
│   │   └── pruning.py        # PruningInput, PruningResult, Placeholder
│   └── ports/                # Protocol（インターフェース定義）
│       ├── equivalence_checker.py   # EquivalenceCheckerPort (check / check_batch)
│       ├── preprocessor.py          # PreprocessorPort
│       └── pruner.py                # PrunerPort
│
├── use_cases/                # === Use Cases 層 ===
│   ├── equivalence_verification.py # EquivalenceCheckerPort を注入、verify / verify_batch
│   ├── preprocessing/selakovic.py  # PreprocessorPort を注入
│   └── pruning.py                  # PrunerPort を注入
│
├── adapters/                 # === Interface Adapters 層 ===
│   ├── cli/                  # 入力アダプター (Typer CLI = composition root)
│   │   ├── __init__.py       # Typer アプリ統合 + main()
│   │   ├── _utils.py         # 共通ヘルパ (resolve_workers 等)
│   │   ├── equivalence.py    # check-equivalence / check-equivalence-batch
│   │   ├── preprocessing.py  # preprocess-selakovic / preprocess-selakovic-batch
│   │   └── pruning.py        # prune / prune-batch
│   └── gateways/             # 外部連携アダプター (Node ランナー subprocess 実装)
│       ├── equivalence/      # NodeRunnerEquivalenceGateway
│       ├── preprocessing/selakovic/  # NodeRunner + dataset_scanner
│       └── pruning/          # NodeRunnerPruningGateway
│
└── infrastructure/           # === Frameworks & Drivers 層（最外層）===
    └── config.py             # pydantic-settings (Settings クラス、mb_analyzer 2 フィールド)

tests/                        # テスト (CA 構造をミラー)
├── domain/entities/
├── use_cases/
├── adapters/{cli,gateways}/
├── fixtures/selakovic/       # 等価性検証の Selakovic 10 パターン fixture
└── infrastructure/
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

各段の Python 側はいずれも「JSONL ロード → Node ランナー (`mb-analyzer/dist/cli.js`) subprocess 起動 → 結果を domain モデルに変換」の薄いオーケストレーション。

---

## 新機能追加ガイド

Python 側の CA レイヤー構造 (domain → use_cases → adapters → infrastructure) を遵守すること。

### 1. 新しい CLI コマンドの追加

1. `mb_scanner/adapters/cli/` に新しい Python ファイルを作成する
2. `Typer` を使用してコマンドと引数を定義する
3. CLI 内で use_case のインスタンスを組み立て (composition root)、実行する
4. `mb_scanner/adapters/cli/__init__.py` に新しいコマンドを登録する

### 2. 新しいドメインモデルの追加

1. `mb_scanner/domain/entities/` に Pydantic BaseModel を定義する
2. 外部連携が必要な場合は `mb_scanner/domain/ports/` に Protocol を定義する
3. `mb_scanner/adapters/` で Protocol の具象実装を作成する

### 3. 新しい Use Case の追加

1. `mb_scanner/use_cases/` に新しいモジュールを作成する
2. コンストラクタで Protocol を受け取り、具象実装を直接 import しない
3. CLI の composition root で具象実装を注入する

### 4. 新しいパイプライン段階 (Node ランナー連携) の追加

1. `mb-analyzer/src/cli/` 側にサブコマンドを追加する (TS 側ドキュメント参照)
2. `mb_scanner/domain/entities/` に入出力モデル、`domain/ports/` に Protocol を定義する (TS 契約の Python ミラー)
3. `mb_scanner/adapters/gateways/` に NodeRunner gateway を実装する (subprocess 起動 + エラー写像)
4. `mb_scanner/use_cases/` と `mb_scanner/adapters/cli/` を追加し、`cli/__init__.py` に登録する

### 5. 並列バッチ処理の追加

- 並列化は **Python 側 `ThreadPoolExecutor`** で実施 (subprocess 起動は I/O バウンドなので GIL 解放される)
- `mb_scanner/adapters/cli/_utils.py` の `resolve_workers(workers)` で `workers=-1 → os.cpu_count() or 1` を統一解決
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
- **ドメインモデル (Pydantic BaseModel)**: `mb_scanner/domain/entities/` に配置する。dataclass は使わない
- **TypedDict**: 原則として使用するモジュール内に定義する。複数モジュールで再利用する場合のみ `domain/entities/` へ移動する

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
- **`Port`**: `domain/ports/` の Protocol

### 静的解析ツール

- **Linter/Formatter**: `ruff` (`mise run fix` で実行)
- **Type Checker**: `pyright` (`mise run typecheck` で実行)
- **Architecture**: `import-linter` (`mise run check-arch` で実行)

---

## データベース

本体にデータベースは無い。旧 SQLite + SQLAlchemy の設計 (projects / topics / project_topics) は [MB-scanner-legacy](https://github.com/tomoya0318/MB-scanner-legacy) を参照。データ実体 `data/mb_scanner.db` はファイルとして残置している (本体コードからの参照は無い)。
