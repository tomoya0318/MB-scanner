"""CLI パッケージの初期化とコマンド統合。"""

from typer import Typer

from mb_scanner.adapters.cli.benchmark import benchmark_app
from mb_scanner.adapters.cli.codeql import codeql_app
from mb_scanner.adapters.cli.count_lines import count_lines_app
from mb_scanner.adapters.cli.equivalence import equivalence_app
from mb_scanner.adapters.cli.github import github_app
from mb_scanner.adapters.cli.migrate import migrate_app
from mb_scanner.adapters.cli.pruning import pruning_app
from mb_scanner.adapters.cli.search import search_app
from mb_scanner.adapters.cli.visualize import visualize_app

app = Typer(help="MB-Scanner CLI - GitHub リポジトリ検索と保存ツール")

app.registered_commands.extend(search_app.registered_commands)
app.registered_groups.extend(search_app.registered_groups)

app.add_typer(codeql_app, name="codeql")
app.add_typer(github_app, name="github")

app.registered_commands.extend(count_lines_app.registered_commands)
app.registered_groups.extend(count_lines_app.registered_groups)

app.registered_commands.extend(migrate_app.registered_commands)
app.registered_groups.extend(migrate_app.registered_groups)

app.add_typer(visualize_app, name="visualize")
app.add_typer(benchmark_app, name="benchmark")

# 新 check-equivalence サブコマンド (Node ランナー経由)
app.registered_commands.extend(equivalence_app.registered_commands)
app.registered_groups.extend(equivalence_app.registered_groups)

# pruning サブコマンド (Node ランナー経由、PR #3)
app.registered_commands.extend(pruning_app.registered_commands)
app.registered_groups.extend(pruning_app.registered_groups)


def main() -> None:
    """CLI のエントリーポイント。"""
    app()


__all__ = ["app", "main"]
