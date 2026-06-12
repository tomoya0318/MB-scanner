# アーキテクチャ・設計ガイド

ドキュメント配置の規約 (4 軸の住み分け、コメント層分離、in-tree README) は [`doc-strategy/index.md`](../doc-strategy/index.md) に集約。本文書は **Contract — TS / Python 双方の依存方向ルール、契約、共通コーディング規約** を扱う。

---

## プロジェクト概要

MB-Scanner は、マイクロベンチマーク由来のパフォーマンスパターンを導出する研究実装です。Selakovic dataset の前処理 → 等価性検証器 (vm + 4 オラクル) → Pruning → 核抽出 → 条件抽出・同値分割テスト → ts-eslint ルール生成、というパイプラインを Python (オーケストレータ) + TypeScript (解析本体) で構成します。旧 GitHub 検索 / CodeQL バッチプラットフォームは [MB-scanner-legacy](https://github.com/tomoya0318/MB-scanner-legacy) へ切り出して凍結済み (2026-06)。

## 構成

本プロジェクトは **Python 側 (`mb_scanner/`)** と **TypeScript 側 (`mb-analyzer/`)** の 2 つのコードベースから成ります。言語ごとに依存方向ルールと静的解析の体系が異なるため、以下の 2 文書で個別に詳細を扱います。

- [`mb-scanner.md`](mb-scanner.md) — Python 側の Clean Architecture 4 層、ドメインモデル、DB 設計、Python コーディング規約
- [`mb-analyzer.md`](mb-analyzer.md) — TypeScript 側の依存方向ゾーン、ESLint 機械強制、サンドボックス、TS 新機能の追加

本 index.md では両コードベースにまたがる **共通概念** のみを扱います。

---

## 共通のアーキテクチャ原則

### Clean Architecture (依存方向は常に内側に向かう)

両コードベースとも Clean Architecture を採用し、依存方向が外側 → 内側に向かう構造を取ります。

- **Python 側**: `domain → use_cases → adapters → infrastructure` の 4 層を `import-linter` で機械強制
- **TypeScript 側**: `{contracts, ast} (末端層) → preprocessing → equivalence-checker → pruning → … → cli (composition root)` のゾーン構造を ESLint `import/no-restricted-paths` で機械強制 (各機能の `common/` は `selakovic/` を import 禁止 = dataset 非依存層)

詳細な契約は言語別ドキュメント参照。

### 役割分担

- **Python 側 (`mb_scanner/`)**: 並列バッチ実行 (`ThreadPoolExecutor`)、JSONL 入出力、CLI エントリポイント
- **TypeScript 側 (`mb-analyzer/`)**: AST 解析とサンドボックス実行を担う薄い CLI。Python 側から `dist/cli.js` を subprocess 起動して stdin/stdout の JSON で呼び出される

---

## Python ↔ Node の JSON 契約

両コードベースをまたぐ通信は `subprocess` の stdin/stdout に載せた JSON/JSONL で行います。契約破りは静的解析で検出できないため、以下の規約を厳守します。

### フィールド命名

- **snake_case で統一**: Python 側 `EquivalenceInput.timeout_ms` ↔ TS 側 `EquivalenceInput.timeout_ms`
- **列挙値文字列も完全一致**: `"equal" / "not_equal" / "error"` など。片側だけ変更しない。

### スキーマ互換性

- **Python 側 `EquivalenceCheckResult` は `extra="ignore"`**: TS 側が将来フィールドを足しても壊れない
- **Python 側 `EquivalenceInput` は `extra="forbid"`**: 想定外の入力を早期失敗させる

### バッチ API の順序独立性 (`id` エコーバック)

- バッチ API では Python 側が `id: str` を付与、Node 側が結果にエコーバック
- Python ↔ Node 間で順序暗黙依存を持たず、`id` をキーにマッピングして復元する
- id 欠落の場合は Python 側で `line-NNNN` 等を自動補完

### 受け渡し乖離の検出 (`effective_timeout_ms`)

- Node の checker が実際に使った `timeout_ms` を結果にエコーバック
- Python Gateway が入力値と照合し、乖離していれば warning を `error_message` に注入
- 過去に Python→Node で `timeout_ms` がサイレントに DEFAULT=5000 にフォールバックした事例への多重防御

### JSON シリアライズ時の明示

- Python → Node へ送る際は `model_dump_json(exclude_defaults=False, exclude_none=False)` を明示
- 将来のリファクタで timeout_ms などがシリアライズから落ちる事故を防ぐ

---

## 共通コーディング規約 (両側)

機械強制できないが両コードベースで揃えたい規約をここに集約します。判定基準は **両言語に同じ意図で適用したいスタイルで、機械強制できないもの**。言語固有の具体化は [`mb-scanner.md`](mb-scanner.md) / [`mb-analyzer.md`](mb-analyzer.md) の「コーディング規約」節へ。

### ファイル内の宣言順序: bottom-up

データ宣言ファイル / モジュールは bottom-up で並べます:

1. 公開型 (`export type` / `class` / Pydantic Model)
2. private helper (補助定数 / 内部 function)
3. builder / factory function
4. ★ exported const = ファイルの contract

理由: ファイル末尾の「結論」を読む時点で依存部品が出揃っている状態にすることで、読み手が前方参照のために戻る必要がなくなる。Python は def hoisting が無いため物理的にこの順序が必須となるケースが多い。TypeScript は `function` 宣言の hoisting で `export const X = build()` を上に置けるが、本規約では bottom-up に揃える。

代表例:
- TS: `mb-analyzer/src/pruning/rules/whitelist.ts`, `blacklist.ts`
- Python: `mb_scanner/domain/entities/*.py`

---

## 新機能をどちら側に書くかの判断

| 機能の性質 | 実装先 |
|---|---|
| AST 解析、サンドボックス実行、ts-eslint ルール、ESTree 操作 | **TS (`mb-analyzer/`)** |
| 並列実行、JSONL 入出力、CLI エントリ | **Python (`mb_scanner/`)** |
| バッチのオーケストレーション、結果集約、ユーザー向け出力 | **Python** |
| 新しい oracle、sandbox の安定化処理 | **TS** |
| 両方にまたがる場合 | **TS に解析ロジック → Python が subprocess 呼び出し** のパターンを維持 |

迷ったら「Python は薄いオーケストレータ、TS は薄い CLI」の役割分担を崩さないことを優先します。

---

## 自動検証コマンド (両側)

```bash
mise run check              # 下記すべてを一括実行（CI と同等）
mise run check-arch         # Python: import-linter でレイヤー契約を検証
mise run typecheck          # Python: pyright 型チェック
mise run lint               # Python: ruff Lint
mise run typecheck-analyzer # TS: tsc --noEmit
mise run lint-analyzer      # TS: ESLint (依存方向検査込み)
mise run test               # Python: pytest
mise run test-analyzer      # TS: vitest
mise run build-analyzer     # TS: esbuild で dist/cli.js をバンドル (Python から利用する前に必要)
mise run fix                # Python: ruff format + ruff check --fix
```
