# 開発環境セットアップガイド

## 技術スタック

| ツール | 用途 | コマンド例 |
| :--- | :--- | :--- |
| **uv** | 高速パッケージ管理 | `uv sync`, `uv add`, `uv run` |
| **mise** | タスクランナー + ツール管理 | `mise run fix`, `mise run typecheck` |
| **Python** | ランタイム | 3.13+ |
| **Node.js / pnpm** | mb-analyzer (TS 側) のビルド・実行 | `mise run build-analyzer` |

## 重要なルール

- **パッケージ管理**: 必ず `uv` を使用すること。`pip` や `poetry` は使用禁止。
  - 追加: `uv add <package>`
  - 開発用追加: `uv add --dev <package>`
  - 同期: `uv sync`
- **タスクランナー**: コマンド実行には `mise` を使用すること（例: `mise run fix`, `mise run typecheck`）。

## 初回セットアップ / 環境リセット

1. `.env` ファイルが存在するか確認し、なければ `.env.sample` からコピーして作成する（任意。デフォルトのままなら不要）。
   ```bash
   cp .env.sample .env
   ```
2. `uv sync` を実行して依存関係をインストールする。
3. `mise run build-analyzer` で TS 側 CLI バンドル (`mb-analyzer/dist/cli.js`) を生成する。

## アプリケーション実行

```bash
uv run mbs <subcommand>   # mbs はエイリアス
```

## トラブルシューティング

- **ImportError**: `uv run` を先頭につけてコマンドを実行する。
- **CLIコマンドが認識されない**: `uv pip install -e .` で編集可能モードで再インストールする。
- **mb-analyzer 関連のエラー (`dist/cli.js` が無い)**: `mise run build-analyzer` を実行する。
