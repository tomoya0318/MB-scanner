"""プロジェクトのJavaScript行数をカウントするコマンドの実装。

count-lines コマンドを定義し、data/repositories に保存されているプロジェクトの
JavaScriptファイルの総行数をカウントしてデータベースに保存します。
"""

import logging
from pathlib import Path
from typing import Annotated

import typer

from mb_scanner.adapters.gateways.code_counter.js_counter import JSLinesCounter
from mb_scanner.adapters.repositories.sqlalchemy_project_repo import SqlAlchemyProjectRepository
from mb_scanner.infrastructure.db.session import get_db, init_db
from mb_scanner.infrastructure.logging_config import setup_logging

# Typer アプリケーションを作成
count_lines_app = typer.Typer()

# ロギングの設定
setup_logging()
logger = logging.getLogger(__name__)


def _convert_full_name_to_dir_name(full_name: str) -> str:
    """プロジェクトのfull_nameをディレクトリ名に変換する

    Args:
        full_name: プロジェクト名（owner/repo形式）

    Returns:
        str: ディレクトリ名（owner-repo形式）

    Example:
        >>> _convert_full_name_to_dir_name("facebook/react")
        'facebook-react'
    """
    return full_name.replace("/", "-")


@count_lines_app.command()
def count_lines(
    repositories_dir: Annotated[
        Path,
        typer.Option(
            "--repositories-dir",
            "-r",
            help="リポジトリディレクトリのパス",
        ),
    ] = Path("data/repositories"),
    batch_size: Annotated[
        int,
        typer.Option(
            "--batch-size",
            "-b",
            help="一度にコミットするプロジェクト数",
            min=1,
        ),
    ] = 100,
    force: Annotated[
        bool,
        typer.Option(
            "--force",
            "-f",
            help="既にカウント済みのプロジェクトも再カウント",
        ),
    ] = False,
) -> None:
    """プロジェクトのJavaScript行数をカウントしてデータベースに保存する。

    data/repositories に保存されているプロジェクトのJavaScriptファイルの
    総行数をカウントし、データベースに保存します。

    例:
        mb-scanner count-lines

        mb-scanner count-lines --force

        mb-scanner count-lines --repositories-dir /path/to/repos --batch-size 50
    """
    try:
        # データベースを初期化
        logger.info("Initializing database...")
        init_db()

        # リポジトリディレクトリの確認
        if not repositories_dir.exists():
            typer.echo(
                typer.style(
                    f"エラー: リポジトリディレクトリが見つかりません: {repositories_dir}",
                    fg=typer.colors.RED,
                )
            )
            raise typer.Exit(code=1)

        # 設定を表示
        typer.echo("\n設定:")
        typer.echo(f"  リポジトリディレクトリ: {repositories_dir}")
        typer.echo(f"  バッチサイズ: {batch_size}")
        typer.echo(f"  再カウント: {'有効' if force else '無効'}")
        typer.echo()

        # データベースセッションを取得
        db_generator = get_db()
        db = next(db_generator)

        try:
            # サービスを初期化
            project_repo = SqlAlchemyProjectRepository(db=db)
            counter = JSLinesCounter()

            # 全プロジェクトを取得
            projects = project_repo.get_all_projects()

            if not projects:
                typer.echo("プロジェクトが見つかりませんでした。")
                return

            typer.echo(f"プロジェクト総数: {len(projects)}")
            typer.echo("カウントを開始します...\n")

            # 統計
            stats = {
                "processed": 0,
                "updated": 0,
                "skipped": 0,
                "not_found": 0,
                "errors": 0,
            }

            # プロジェクトを処理
            for idx, project in enumerate(projects, start=1):
                try:
                    # 既にカウント済みでforceがFalseの場合はスキップ
                    if not force and project.js_lines_count is not None:
                        logger.info(f"[{idx}/{len(projects)}] スキップ（既存）: {project.full_name}")
                        stats["skipped"] += 1
                        continue

                    # ディレクトリ名を生成
                    dir_name = _convert_full_name_to_dir_name(project.full_name)
                    repo_dir = repositories_dir / dir_name

                    # ディレクトリが存在しない場合はスキップ
                    if not repo_dir.exists():
                        logger.info(f"[{idx}/{len(projects)}] スキップ（未発見）: {project.full_name}")
                        stats["not_found"] += 1
                        continue

                    # JS行数をカウント
                    lines_count = counter.count_lines_in_directory(repo_dir)

                    # データベースを更新
                    assert project.id is not None
                    project_repo.update_js_lines_count(project.id, lines_count)

                    logger.info(f"[{idx}/{len(projects)}] 更新完了: {project.full_name} ({lines_count} lines)")
                    stats["updated"] += 1
                    stats["processed"] += 1

                except Exception as e:
                    logger.error(f"[{idx}/{len(projects)}] エラー: {project.full_name} - {e}")
                    stats["errors"] += 1

            # 結果を表示
            typer.echo()
            typer.echo("結果:")
            typer.echo(f"  処理完了: {stats['processed']}")
            typer.echo(f"  更新: {stats['updated']}")
            typer.echo(f"  スキップ（既存）: {stats['skipped']}")
            typer.echo(f"  スキップ（未発見）: {stats['not_found']}")
            typer.echo(f"  エラー: {stats['errors']}")
            typer.echo()

            if stats["errors"] > 0:
                typer.echo(
                    typer.style(
                        "警告: 一部のプロジェクトの処理に失敗しました。ログを確認してください。",
                        fg=typer.colors.YELLOW,
                    )
                )
            else:
                typer.echo(typer.style("✓ 完了しました！", fg=typer.colors.GREEN))

        finally:
            # データベースセッションをクローズ
            db.close()

    except KeyboardInterrupt:
        typer.echo("\n処理を中断しました。")
        raise typer.Exit(code=130) from None
    except Exception as e:
        logger.exception("Error occurred during count-lines command")
        typer.echo(
            typer.style(f"エラーが発生しました: {e}", fg=typer.colors.RED),
            err=True,
        )
        raise typer.Exit(code=1) from e


__all__ = ["count_lines_app"]
