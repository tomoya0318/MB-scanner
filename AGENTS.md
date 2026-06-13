# AGENTS.md

## プロジェクト概要
MB-Scanner: マイクロベンチマーク由来のパフォーマンスパターン導出の研究実装。Selakovic 前処理 → 等価性検証 (vm/jsdom + 6 オラクル) → Pruning → 核抽出 → 条件抽出 → ts-eslint ルール生成のパイプラインを Python (オーケストレータ) + TypeScript (`mb-analyzer/`、解析本体) で構成する。旧 GitHub 検索 / CodeQL バッチプラットフォームは [MB-scanner-legacy](https://github.com/tomoya0318/MB-scanner-legacy) へ切り出し済み (2026-06 凍結)。

## アーキテクチャ
feature-first 構成を採用 (ADR-0030)。パイプライン段 (preprocessing / equivalence / pruning) を
ディレクトリの第一軸とし、各段に機能を凝集させる。
- 各段 (`mb_scanner/<段>/`): `cli.py`（Typer commands）/ `gateway.py`（Port Protocol + Node ランナー実装を同居）/ `models.py`（Pydantic モデル）。equivalence は verdict 導出を `verdict.py`、preprocessing は dataset 列挙を `dataset.py` に持つ。
- 共通基盤 (パッケージルート): `cli.py`（各段の Typer app を統合する composition root）/ `config.py`（pydantic-settings）/ `_utils.py`。
- 段間は相互不可侵 (independence): equivalence / pruning / preprocessing は互いに import しない。cli は Protocol 型で DI を受け、具象 gateway をルートの composition root (`cli.py`) で注入する。
- models（型契約）と gateway は CLI フレームワーク (`typer`) に依存しない。

依存方向の自動検証: `mise run check-arch`（import-linter の independence + forbidden 契約）

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
- **モデル定義**: 各段の `models.py` に Pydantic BaseModel で定義。dataclass は使わない。
- **依存方向**: 段は互いに import しない (independence)。cli は Protocol 型で DI を受け、具象 gateway はルートの composition root (`cli.py`) で注入する。
- **命名**: GitHubリポジトリは `Project` と呼ぶ（`Repository` は DB パターン用語）。
- **Lint/Format**: `ruff`の設定に従うこと。
- **テスト**: 新機能には必ず`pytest`を作成すること。
- **コメント・設計判断**: コメントの層分離 / ADR 運用は [`ai-guide/architecture/index.md`](ai-guide/architecture/index.md) 参照。
