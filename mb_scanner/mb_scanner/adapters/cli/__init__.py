"""CLI パッケージの初期化とコマンド統合。"""

from typer import Typer

from mb_scanner.adapters.cli.equivalence import equivalence_app
from mb_scanner.adapters.cli.preprocessing import preprocessing_app
from mb_scanner.adapters.cli.pruning import pruning_app

app = Typer(help="MB-Scanner CLI - マイクロベンチマーク研究パイプライン (preprocess / equivalence / pruning)")

app.registered_commands.extend(equivalence_app.registered_commands)
app.registered_groups.extend(equivalence_app.registered_groups)

app.registered_commands.extend(pruning_app.registered_commands)
app.registered_groups.extend(pruning_app.registered_groups)

app.registered_commands.extend(preprocessing_app.registered_commands)
app.registered_groups.extend(preprocessing_app.registered_groups)


def main() -> None:
    """CLI のエントリーポイント。"""
    app()


__all__ = ["app", "main"]
