"""CLI パッケージの初期化とコマンド統合。"""

from typer import Typer

from mb_scanner.adapters.cli.equivalence import equivalence_app
from mb_scanner.adapters.cli.migrate import migrate_app
from mb_scanner.adapters.cli.preprocessing import preprocessing_app
from mb_scanner.adapters.cli.pruning import pruning_app

app = Typer(help="MB-Scanner CLI - GitHub リポジトリ検索と保存ツール")

app.registered_commands.extend(migrate_app.registered_commands)
app.registered_groups.extend(migrate_app.registered_groups)

# 新 check-equivalence サブコマンド (Node ランナー経由)
app.registered_commands.extend(equivalence_app.registered_commands)
app.registered_groups.extend(equivalence_app.registered_groups)

# pruning サブコマンド (Node ランナー経由、PR #3)
app.registered_commands.extend(pruning_app.registered_commands)
app.registered_groups.extend(pruning_app.registered_groups)

# preprocessing (Selakovic dataset 前処理) サブコマンド (Node ランナー経由、PR #4)
app.registered_commands.extend(preprocessing_app.registered_commands)
app.registered_groups.extend(preprocessing_app.registered_groups)


def main() -> None:
    """CLI のエントリーポイント。"""
    app()


__all__ = ["app", "main"]
