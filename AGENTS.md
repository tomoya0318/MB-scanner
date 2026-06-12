# AGENTS.md

## プロジェクト概要
MB-Scanner: マイクロベンチマーク由来のパフォーマンスパターン導出の研究実装。Selakovic 前処理 → 等価性検証 (vm + 4 オラクル) → Pruning → 核抽出 → 条件抽出 → ts-eslint ルール生成のパイプラインを Python (オーケストレータ) + TypeScript (`mb-analyzer/`、解析本体) で構成する。旧 GitHub 検索 / CodeQL バッチプラットフォームは [MB-scanner-legacy](https://github.com/tomoya0318/MB-scanner-legacy) へ切り出し済み (2026-06 凍結)。

## アーキテクチャ
Clean Architecture 4層構造を採用。依存は常に内側に向かう。
- **domain** (最内層): エンティティ（Pydantic BaseModel）+ ポート（Protocol）
- **use_cases**: ビジネスロジック。Protocol 経由で DI。
- **adapters**: CLI（composition root）、Gateway（Node ランナー subprocess）
- **infrastructure** (最外層): 設定 (pydantic-settings)

依存方向の自動検証: `mise run check-arch`（import-linter）

TypeScript 側 (`mb-analyzer/`) も ESLint `import/no-restricted-paths` で依存方向を機械強制 (`mise run lint-analyzer`)。詳細は [`ai-guide/architecture/`](ai-guide/architecture/index.md) 参照。言語別の参照ドキュメント:
- Python 側の詳細: [`mb-scanner.md`](ai-guide/architecture/mb-scanner.md)
- TypeScript 側の詳細: [`mb-analyzer.md`](ai-guide/architecture/mb-analyzer.md)
- 両言語をまたぐ JSON 契約: [`index.md`](ai-guide/architecture/index.md)

## 技術スタック
- **言語**: Python 3.13+ / TypeScript (Node 22, `mb-analyzer/`)
- **CLIフレームワーク**: `typer` (コマンドラインインターフェース構築)
- **データ/設定管理**: `pydantic` (バリデーション), `pydantic-settings` (.env管理)
- **外部連携**: `subprocess` (`node mb-analyzer/dist/cli.js` の起動、stdin/stdout JSON/JSONL)
- **開発ツール**:
  - `uv` (パッケージ管理)
  - `mise` (タスクランナー + ツールバージョン管理)
  - `ruff` (Lint/Format)
  - `pyright` (型チェック)
  - `pytest` (テスト)
  - `import-linter` (アーキテクチャ検証)

## 重要なコーディング規約
- **型定義**: `Any`型は禁止。外部データには`Pydantic`、内部データには`TypedDict`を使用すること。
- **ドメインモデル**: `domain/entities/` に Pydantic BaseModel で定義。dataclass は使わない。
- **依存方向**: use_cases は具象アダプターを import しない。Protocol 経由で DI。
- **命名**: GitHubリポジトリは `Project` と呼ぶ（`Repository` は DB パターン用語）。
- **Lint/Format**: `ruff`の設定に従うこと。
- **テスト**: 新機能には必ず`pytest`を作成すること。
- **コメント・設計判断**: コメントの層分離 / ADR 運用は [`ai-guide/architecture/index.md`](ai-guide/architecture/index.md) 参照。
