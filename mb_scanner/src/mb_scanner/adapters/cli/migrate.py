"""データベースマイグレーションコマンドの実装。

migrate コマンドを定義し、データベーススキーマの更新を実行します。
"""

import logging
from typing import Annotated

import typer

from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.db.migrations import DatabaseMigrator, MigrationError
from mb_scanner.infrastructure.logging_config import setup_logging

# Typer アプリケーションを作成
migrate_app = typer.Typer()

# ロギングの設定
setup_logging()
logger = logging.getLogger(__name__)


@migrate_app.command()
def migrate(
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            "-d",
            help="実際には実行せず、実行予定の内容のみを表示",
        ),
    ] = False,
) -> None:
    """データベースマイグレーションを実行する。

    データベーススキーマを最新の状態に更新します。
    既に適用済みのマイグレーションはスキップされます（冪等性）。

    例:
        mb-scanner migrate

        mb-scanner migrate --dry-run
    """
    try:
        # 設定を表示
        typer.echo("\nデータベースマイグレーション")
        typer.echo(f"  データベースパス: {settings.effective_db_file}")
        if dry_run:
            typer.echo("  モード: ドライラン（実際には実行されません）")
        typer.echo()

        # データベースファイルの存在確認
        if not settings.effective_db_file.exists():
            typer.echo(
                typer.style(
                    f"エラー: データベースファイルが見つかりません: {settings.effective_db_file}",
                    fg=typer.colors.RED,
                )
            )
            raise typer.Exit(code=1)

        # マイグレーターを初期化
        migrator = DatabaseMigrator(settings.effective_db_file)

        # マイグレーションを実行
        typer.echo("マイグレーションを開始します...\n")
        results = migrator.run_all_migrations(dry_run=dry_run)

        # 結果を表示
        typer.echo("\n結果:")
        executed_count = 0
        skipped_count = 0

        for name, executed in results.items():
            if executed:
                status = "実行" if not dry_run else "実行予定"
                typer.echo(typer.style(f"  ✓ {name}: {status}", fg=typer.colors.GREEN))
                executed_count += 1
            else:
                typer.echo(typer.style(f"  - {name}: スキップ（既存）", fg=typer.colors.YELLOW))
                skipped_count += 1

        typer.echo()
        typer.echo(f"実行: {executed_count}")
        typer.echo(f"スキップ: {skipped_count}")
        typer.echo()

        if executed_count > 0:
            if dry_run:
                typer.echo(
                    typer.style(
                        "ドライランモードで実行しました。実際にマイグレーションを適用するには --dry-run を外して実行してください。",
                        fg=typer.colors.CYAN,
                    )
                )
            else:
                typer.echo(typer.style("✓ マイグレーションが完了しました！", fg=typer.colors.GREEN))
        else:
            typer.echo("データベースは既に最新の状態です。")

    except MigrationError as e:
        logger.exception("Migration error occurred")
        typer.echo(
            typer.style(f"マイグレーションエラー: {e}", fg=typer.colors.RED),
            err=True,
        )
        raise typer.Exit(code=1) from e
    except KeyboardInterrupt:
        typer.echo("\n処理を中断しました。")
        raise typer.Exit(code=130) from None
    except Exception as e:
        logger.exception("Unexpected error occurred during migration")
        typer.echo(
            typer.style(f"予期しないエラーが発生しました: {e}", fg=typer.colors.RED),
            err=True,
        )
        raise typer.Exit(code=1) from e


__all__ = ["migrate_app"]
