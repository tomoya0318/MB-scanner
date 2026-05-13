"""CodeQL クエリ実行コマンド"""

from pathlib import Path

import typer

from mb_scanner.adapters.gateways.codeql import CodeQLCLI, CodeQLDatabaseManager
from mb_scanner.adapters.gateways.codeql.analyzer import CodeQLResultAnalyzer
from mb_scanner.adapters.repositories.sqlalchemy_project_repo import SqlAlchemyProjectRepository
from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.db.session import SessionLocal
from mb_scanner.use_cases.codeql_query_execution import CodeQLQueryExecutionWorkflow


def query(
    project_name: str = typer.Argument(..., help="プロジェクト名（owner/repo形式）"),
    query_files: list[Path] = typer.Option(..., "--query-files", "-q", help="クエリファイルのパス"),
    format: str | None = typer.Option(None, "--format", help="出力形式"),
    threads: int | None = typer.Option(None, "--threads", help="使用するスレッド数"),
    ram: int | None = typer.Option(None, "--ram", help="使用するRAM（MB）"),
) -> None:
    """指定したプロジェクトのCodeQLデータベースに対してクエリを実行する"""
    if format is None:
        format = settings.codeql_default_output_format

    typer.echo(f"Executing CodeQL query for: {project_name}")
    typer.echo(f"Query files: {', '.join(str(q) for q in query_files)}")
    typer.echo(f"Output directory: {settings.effective_codeql_output_dir}")

    codeql_cli = CodeQLCLI(cli_path=settings.codeql_cli_path)
    db_manager = CodeQLDatabaseManager(cli=codeql_cli, base_dir=settings.effective_codeql_db_dir)
    analyzer = CodeQLResultAnalyzer()
    workflow = CodeQLQueryExecutionWorkflow(codeql_cli=codeql_cli, db_manager=db_manager, result_analyzer=analyzer)

    result = workflow.execute_query_for_project(
        project_full_name=project_name,
        query_files=query_files,
        output_base_dir=settings.effective_codeql_output_dir,
        format=format,
        threads=threads,
        ram=ram,
    )

    if result["status"] == "success":
        typer.echo(f"Successfully executed {len(result['results'])} queries")
        for query_result in result["results"]:
            typer.echo(f"  - {query_result['query_file']}: {query_result['result_count']} results")
            typer.echo(f"    Output: {query_result['output_path']}")
    elif result["status"] == "error":
        typer.echo(f"Error: {result['error']}", err=True)
        raise typer.Exit(code=1)


def query_batch(
    query_files: list[Path] = typer.Option(..., "--query-files", "-q", help="クエリファイルのパス"),
    max_projects: int | None = typer.Option(None, "--max-projects", help="最大プロジェクト数"),
    format: str | None = typer.Option(None, "--format", help="出力形式"),
    threads: int | None = typer.Option(None, "--threads", help="使用するスレッド数"),
    ram: int | None = typer.Option(None, "--ram", help="使用するRAM（MB）"),
) -> None:
    """データベース上の全プロジェクトに対してクエリを一括実行する"""
    if format is None:
        format = settings.codeql_default_output_format

    typer.echo("Starting batch CodeQL query execution")
    typer.echo(f"Query files: {', '.join(str(q) for q in query_files)}")
    typer.echo(f"Max projects: {max_projects or 'unlimited'}")
    typer.echo(f"Output directory: {settings.effective_codeql_output_dir}")

    db = SessionLocal()
    try:
        project_repo = SqlAlchemyProjectRepository(db)
        all_projects = project_repo.get_all_projects()

        if not all_projects:
            typer.echo("No projects found in database")
            return

        project_names = [project.full_name for project in all_projects]
        if max_projects is not None:
            project_names = project_names[:max_projects]

        typer.echo(f"Found {len(project_names)} projects")

        codeql_cli = CodeQLCLI(cli_path=settings.codeql_cli_path)
        db_manager = CodeQLDatabaseManager(cli=codeql_cli, base_dir=settings.effective_codeql_db_dir)
        analyzer = CodeQLResultAnalyzer()
        workflow = CodeQLQueryExecutionWorkflow(codeql_cli=codeql_cli, db_manager=db_manager, result_analyzer=analyzer)

        stats = workflow.execute_queries_batch(
            projects=project_names,
            query_files=query_files,
            output_base_dir=settings.effective_codeql_output_dir,
            format=format,
            threads=threads,
            ram=ram,
        )

        typer.echo("\n=== Batch Execution Summary ===")
        typer.echo(f"Total: {stats['total']}")
        typer.echo(f"Success: {stats['success']}")
        typer.echo(f"Failed: {stats['failed']}")
    finally:
        db.close()
