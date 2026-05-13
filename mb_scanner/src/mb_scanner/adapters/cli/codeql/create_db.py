"""CodeQL DB作成コマンド"""

import typer

from mb_scanner.adapters.gateways.codeql import CodeQLCLI, CodeQLDatabaseManager
from mb_scanner.adapters.gateways.github import RepositoryCloner
from mb_scanner.adapters.repositories.sqlalchemy_project_repo import SqlAlchemyProjectRepository
from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.db.session import SessionLocal
from mb_scanner.use_cases.codeql_database_creation import CodeQLDatabaseCreationWorkflow


def create_database(
    project_name: str = typer.Argument(..., help="プロジェクト名（owner/repo形式）"),
    language: str | None = typer.Option(None, help="解析言語"),
    force: bool = typer.Option(False, "--force", "-f", help="既存DBを上書きする"),
) -> None:
    """指定したプロジェクトのCodeQL DBを作成する"""
    if language is None:
        language = settings.codeql_default_language

    typer.echo(f"Creating CodeQL database for: {project_name}")
    typer.echo(f"Language: {language}")

    db = SessionLocal()
    try:
        project_repo = SqlAlchemyProjectRepository(db)
        project = project_repo.get_project_by_full_name(project_name)

        if not project:
            typer.echo(f"Error: Project not found: {project_name}", err=True)
            raise typer.Exit(code=1)

        cloner = RepositoryCloner(github_token=settings.github_token)
        codeql_cli = CodeQLCLI(cli_path=settings.codeql_cli_path)
        db_manager = CodeQLDatabaseManager(cli=codeql_cli, base_dir=settings.effective_codeql_db_dir)
        workflow = CodeQLDatabaseCreationWorkflow(
            cloner=cloner,
            db_manager=db_manager,
            clone_base_dir=settings.effective_codeql_clone_dir,
        )

        result = workflow.create_database_for_project(
            project_full_name=project.full_name,
            repository_url=project.url,
            language=language,
            skip_if_exists=not force,
            force=force,
        )

        if result["status"] == "created":
            typer.echo(f"Successfully created database: {result.get('db_path')}")
        elif result["status"] == "skipped":
            typer.echo(f"Database already exists: {result.get('db_path')}")
            typer.echo("  Use --force to overwrite")
        elif result["status"] == "error":
            typer.echo(f"Error: {result.get('error')}", err=True)
            raise typer.Exit(code=1)
    finally:
        db.close()


def create_database_batch(
    language: str | None = typer.Option(None, help="解析言語"),
    max_projects: int | None = typer.Option(None, help="最大プロジェクト数"),
    skip_existing: bool = typer.Option(True, help="既存DBをスキップする"),
    force: bool = typer.Option(False, "--force", "-f", help="既存DBを上書きする"),
) -> None:
    """DB上の全プロジェクトに対してCodeQL DBを一括作成する"""
    if language is None:
        language = settings.codeql_default_language

    typer.echo("Starting batch CodeQL database creation")
    typer.echo(f"Language: {language}")
    typer.echo(f"Max projects: {max_projects or 'unlimited'}")
    typer.echo(f"Skip existing: {skip_existing}")

    db = SessionLocal()
    try:
        project_repo = SqlAlchemyProjectRepository(db)
        projects = project_repo.get_all_project_urls()

        if not projects:
            typer.echo("No projects found in database")
            return

        if max_projects is not None:
            projects = projects[:max_projects]

        typer.echo(f"Found {len(projects)} projects")

        cloner = RepositoryCloner(github_token=settings.github_token)
        codeql_cli = CodeQLCLI(cli_path=settings.codeql_cli_path)
        db_manager = CodeQLDatabaseManager(cli=codeql_cli, base_dir=settings.effective_codeql_db_dir)
        workflow = CodeQLDatabaseCreationWorkflow(
            cloner=cloner,
            db_manager=db_manager,
            clone_base_dir=settings.effective_codeql_clone_dir,
        )

        stats = workflow.create_databases_batch(
            projects=projects,
            language=language,
            skip_if_exists=skip_existing and not force,
            force=force,
        )

        typer.echo("\n=== Batch Creation Summary ===")
        typer.echo(f"Total: {stats['total']}")
        typer.echo(f"Created: {stats['created']}")
        typer.echo(f"Skipped: {stats['skipped']}")
        typer.echo(f"Failed: {stats['failed']}")
    finally:
        db.close()
