"""GitHub関連のCLIコマンド"""

from datetime import datetime
from typing import cast

from rich.console import Console
from rich.table import Table
import typer

from mb_scanner.adapters.gateways.github import RepositoryCloner
from mb_scanner.adapters.gateways.github.client import GitHubClient
from mb_scanner.adapters.repositories.sqlalchemy_project_repo import SqlAlchemyProjectRepository
from mb_scanner.core.cleanup import cleanup_directory
from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.db.session import SessionLocal

github_app = typer.Typer(name="github", help="GitHub関連のコマンド")
console = Console()


@github_app.command("rate-limit")
def rate_limit() -> None:
    """GitHub APIのレート制限状態を確認する

    Examples:
        $ mb-scanner github rate-limit
    """
    try:
        client = GitHubClient()
        info = client.get_rate_limit_info()

        # ステータスを判定
        limit = cast(int, info["limit"])
        remaining = cast(int, info["remaining"])
        reset_time = cast(datetime, info["reset_time"])

        if remaining == 0:
            status = "✗ RATE LIMITED"
            status_color = "red"
        elif remaining < limit * 0.2:
            status = "⚠ WARNING"
            status_color = "yellow"
        else:
            status = "✓ OK"
            status_color = "green"

        # 表示
        console.print("\n[bold]GitHub API Rate Limit Status[/bold]\n")

        table = Table(show_header=False, box=None)
        table.add_column("Key", style="cyan")
        table.add_column("Value")

        table.add_row("Limit:", f"{limit} requests/hour")
        table.add_row("Remaining:", f"{remaining} requests")
        table.add_row("Reset:", reset_time.strftime("%Y-%m-%d %H:%M:%S %Z"))
        table.add_row("Status:", f"[{status_color}]{status}[/{status_color}]")

        if remaining == 0:
            wait_time = cast(float, info["wait_time_seconds"])
            minutes = int(wait_time // 60)
            table.add_row("Wait time:", f"{minutes} minutes")

        console.print(table)
        console.print()

    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1) from e


@github_app.command("clone")
def clone(
    max_projects: int | None = typer.Option(None, help="最大プロジェクト数"),
    force: bool = typer.Option(False, "--force", "-f", help="既存リポジトリを削除して再クローン"),
) -> None:
    """DB上の全プロジェクトをクローンする

    Examples:
        $ mb-scanner github clone
        $ mb-scanner github clone --max-projects 10
        $ mb-scanner github clone --force
    """
    typer.echo("Starting repository cloning")
    typer.echo(f"Max projects: {max_projects or 'unlimited'}")
    typer.echo(f"Force re-clone: {force}")

    # データベースセッションを作成
    db = SessionLocal()

    try:
        # プロジェクトサービスから全プロジェクトを取得
        project_repo = SqlAlchemyProjectRepository(db)
        projects = project_repo.get_all_project_urls()

        if not projects:
            typer.echo("No projects found in database")
            return

        # max_projectsが指定されている場合は制限
        if max_projects is not None:
            projects = projects[:max_projects]

        typer.echo(f"Found {len(projects)} projects")

        # クローナーを初期化
        cloner = RepositoryCloner(github_token=settings.github_token)
        clone_base_dir = settings.effective_codeql_clone_dir

        # 統計情報
        stats = {
            "total": len(projects),
            "success": 0,
            "skipped": 0,
            "failed": 0,
        }

        for _project_id, full_name, url in projects:
            typer.echo(f"\nProcessing: {full_name}")

            # クローン先のパスを決定
            safe_name = full_name.replace("/", "-")
            clone_path = clone_base_dir / safe_name

            try:
                # forceの場合は既存ディレクトリを削除
                if force and clone_path.exists():
                    typer.echo(f"  Removing existing clone: {clone_path}")
                    cleanup_directory(clone_path, ignore_errors=False)

                # クローン前にディレクトリが存在するかチェック
                existed_before = clone_path.exists()

                # クローン
                typer.echo(f"  Cloning to: {clone_path}")
                cloner.clone(url, clone_path, skip_if_exists=not force)

                # クローン後の判定
                if not existed_before and clone_path.exists():
                    typer.echo("  ✓ Successfully cloned")
                    stats["success"] += 1
                elif existed_before:
                    typer.echo("  ⊘ Skipped (already exists)")
                    stats["skipped"] += 1

            except Exception as e:
                typer.echo(f"  ✗ Error: {e}", err=True)
                stats["failed"] += 1

        # 結果を表示
        typer.echo("\n=== Cloning Summary ===")
        typer.echo(f"Total: {stats['total']}")
        typer.echo(f"✓ Success: {stats['success']}")
        typer.echo(f"⊘ Skipped: {stats['skipped']}")
        typer.echo(f"✗ Failed: {stats['failed']}")

    finally:
        db.close()
