"""GitHub リポジトリ検索コマンドの実装。

search コマンドを定義し、ユーザーからの入力を受け取り、
対応するワークフロー (use_cases/search_and_store) を呼び出します。
"""

import logging
from typing import Annotated

import typer

from mb_scanner.adapters.gateways.github.client import GitHubClient
from mb_scanner.adapters.repositories.sqlalchemy_project_repo import SqlAlchemyProjectRepository
from mb_scanner.domain.ports.github_gateway import SearchCriteria
from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.db.session import get_db, init_db
from mb_scanner.infrastructure.logging_config import setup_logging
from mb_scanner.use_cases.search_and_store import SearchAndStoreWorkflow

# Typer アプリケーションを作成
search_app = typer.Typer()

# ロギングの設定
setup_logging()
logger = logging.getLogger(__name__)


@search_app.command()
def search(
    language: Annotated[
        str,
        typer.Option(
            "--language",
            "-l",
            help="検索対象の主要言語",
        ),
    ] = settings.github_search_default_language,
    min_stars: Annotated[
        int,
        typer.Option(
            "--min-stars",
            "-s",
            help="最小スター数",
            min=0,
        ),
    ] = settings.github_search_default_min_stars,
    max_days_since_commit: Annotated[
        int,
        typer.Option(
            "--max-days-since-commit",
            "-d",
            help="最終コミットからの最大日数",
            min=1,
        ),
    ] = settings.github_search_default_max_days_since_commit,
    max_results: Annotated[
        int | None,
        typer.Option(
            "--max-results",
            "-n",
            help="取得する最大リポジトリ数（指定しない場合は全件取得）",
            min=1,
        ),
    ] = None,
    update: Annotated[
        bool,
        typer.Option(
            "--update",
            "-u",
            help="既存プロジェクトを更新する",
        ),
    ] = False,
) -> None:
    """GitHub リポジトリを検索し、データベースに保存する。

    検索条件を指定して GitHub のリポジトリを検索し、
    結果をデータベースに保存します。

    例:
        mb-scanner search --language Python --min-stars 1000 --max-results 50

        mb-scanner search -l JavaScript -s 500 -d 180 --update
    """
    try:
        # データベースを初期化
        logger.info("Initializing database...")
        init_db()

        # 検索条件を作成
        criteria = SearchCriteria(
            language=language,
            min_stars=min_stars,
            max_days_since_commit=max_days_since_commit,
        )

        # 検索条件を表示
        typer.echo("\n検索条件:")
        typer.echo(f"  言語: {language}")
        typer.echo(f"  最小スター数: {min_stars}")
        typer.echo(f"  最終コミット経過日数: {max_days_since_commit}日以内")
        if max_results:
            typer.echo(f"  最大取得数: {max_results}")
        else:
            typer.echo("  最大取得数: 制限なし")
        typer.echo(f"  既存プロジェクトの更新: {'有効' if update else '無効'}")
        typer.echo()

        # データベースセッションを取得
        db_generator = get_db()
        db = next(db_generator)

        try:
            # 依存を構築してワークフローを実行
            github_client = GitHubClient()
            project_repo = SqlAlchemyProjectRepository(db)
            workflow = SearchAndStoreWorkflow(
                github_client=github_client,
                project_repo=project_repo,
            )
            logger.info("Starting search and store workflow...")
            typer.echo("検索を開始します...")

            stats = workflow.execute(
                criteria=criteria,
                max_results=max_results,
                update_if_exists=update,
            )

            # 結果を表示
            typer.echo()
            typer.echo("検索結果:")
            typer.echo(f"  検索結果総数: {stats['total']}")
            typer.echo(f"  新規保存: {stats['saved']}")
            typer.echo(f"  更新: {stats['updated']}")
            typer.echo(f"  スキップ: {stats['skipped']}")
            typer.echo(f"  失敗: {stats['failed']}")
            typer.echo()

            if stats["failed"] > 0:
                typer.echo(
                    typer.style(
                        "警告: 一部のリポジトリの保存に失敗しました。ログを確認してください。",
                        fg=typer.colors.YELLOW,
                    )
                )
            else:
                typer.echo(typer.style("✓ 完了しました！", fg=typer.colors.GREEN))

            # クリーンアップ
            workflow.close()

        finally:
            # データベースセッションをクローズ
            db.close()

    except KeyboardInterrupt:
        typer.echo("\n処理を中断しました。")
        raise typer.Exit(code=130) from None
    except Exception as e:
        logger.exception("Error occurred during search command")
        typer.echo(
            typer.style(f"エラーが発生しました: {e}", fg=typer.colors.RED),
            err=True,
        )
        raise typer.Exit(code=1) from e


__all__ = ["search_app"]
