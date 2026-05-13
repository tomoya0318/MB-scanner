"""CodeQL コード抽出コマンド"""

from pathlib import Path

from joblib import Parallel, delayed
import typer

from mb_scanner.adapters.gateways.codeql.sarif import SarifExtractor, extract_code_for_project
from mb_scanner.adapters.repositories.sqlalchemy_project_repo import SqlAlchemyProjectRepository
from mb_scanner.domain.entities import CodeExtractionJobResult
from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.db.session import SessionLocal


def extract_code(
    query_id: str = typer.Argument(..., help="クエリID（例: id_10）"),
    project_name: str = typer.Argument(..., help="プロジェクト名（例: facebook-react）"),
    sarif_path: Path | None = typer.Option(None, "--sarif-path", help="SARIFファイルのパス"),
    repository_path: Path | None = typer.Option(None, "--repository-path", help="リポジトリのパス"),
    output: Path | None = typer.Option(None, "--output", help="出力先JSONファイルのパス"),
) -> None:
    r"""SARIFファイルから検出されたコードを抽出する"""
    if sarif_path is None:
        sarif_path = settings.effective_codeql_output_dir / query_id / f"{project_name}.sarif"
    if repository_path is None:
        repository_path = settings.effective_codeql_clone_dir / project_name
    if output is None:
        output = settings.effective_codeql_output_dir / query_id / f"{project_name}_code.json"

    if not sarif_path.exists():
        typer.echo(f"Error: SARIF file not found: {sarif_path}", err=True)
        raise typer.Exit(code=1)
    if not repository_path.exists():
        typer.echo(f"Error: Repository not found: {repository_path}", err=True)
        raise typer.Exit(code=1)

    typer.echo(f"Extracting code from SARIF: {sarif_path}")
    typer.echo(f"Repository: {repository_path}")
    typer.echo(f"Output: {output}")

    try:
        extractor = SarifExtractor(sarif_path=sarif_path, repository_path=repository_path)
        extraction_output = extractor.extract_all()

        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("w", encoding="utf-8") as f:
            f.write(extraction_output.model_dump_json(indent=2))

        typer.echo(f"\nSuccessfully extracted code from {extraction_output.metadata.total_results} results")
        typer.echo(f"  Output file: {output}")

    except FileNotFoundError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1) from e
    except Exception as e:
        typer.echo(f"Unexpected error: {e}", err=True)
        raise typer.Exit(code=1) from e


def extract_code_batch(
    query_id: str = typer.Argument(..., help="クエリID（例: id_10）"),
    max_projects: int | None = typer.Option(None, "--max-projects", help="最大プロジェクト数"),
    threads: int = typer.Option(4, "--threads", "-t", help="使用するスレッド数"),
    sarif_dir: Path | None = typer.Option(None, "--sarif-dir", help="SARIFファイルのディレクトリ"),
    output_dir: Path | None = typer.Option(None, "--output-dir", help="出力先ディレクトリ"),
) -> None:
    """複数プロジェクトのSARIFファイルから並列でコードを抽出"""
    if output_dir is None:
        output_dir = settings.effective_codeql_output_dir
    sarif_base_dir = sarif_dir if sarif_dir is not None else output_dir

    typer.echo("Starting batch code extraction")
    typer.echo(f"Query ID: {query_id}")
    typer.echo(f"Max projects: {max_projects or 'unlimited'}")
    typer.echo(f"Threads: {threads if threads != -1 else 'all cores'}")

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

        typer.echo(f"Found {len(project_names)} projects to process")

        results_list: list[CodeExtractionJobResult] = Parallel(n_jobs=threads, verbose=10)(
            delayed(extract_code_for_project)(
                query_id=query_id,
                project_name=project,
                sarif_base_dir=sarif_base_dir,
                repository_base_dir=settings.effective_codeql_clone_dir,
                output_base_dir=output_dir,
            )
            for project in project_names
        )

        success_count = sum(1 for r in results_list if r.status == "success")
        skipped_count = sum(1 for r in results_list if r.status == "skipped")
        failed_count = sum(1 for r in results_list if r.status == "error")

        typer.echo("\n=== Batch Extraction Summary ===")
        typer.echo(f"Total: {len(results_list)}")
        typer.echo(f"Success: {success_count}")
        typer.echo(f"Skipped: {skipped_count}")
        typer.echo(f"Failed: {failed_count}")

        failed_projects = [r for r in results_list if r.status == "error"]
        if failed_projects:
            typer.echo("\nFailed projects:")
            for result in failed_projects:
                typer.echo(f"  - {result.project}: {result.error}")
    finally:
        db.close()
