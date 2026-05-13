"""CodeQL サマリー生成コマンド"""

from pathlib import Path

import typer

from mb_scanner.adapters.gateways.codeql.analyzer import CodeQLResultAnalyzer
from mb_scanner.infrastructure.config import settings


def summary(
    query_id: str = typer.Argument(..., help="クエリID（例: id_10）"),
    threshold: int | None = typer.Option(None, "--threshold", "-t", help="閾値"),
    output_dir: Path | None = typer.Option(None, "--output-dir", help="出力先ディレクトリ"),
) -> None:
    """指定したクエリIDのサマリーJSONを生成する"""
    if output_dir is None:
        output_dir = settings.effective_codeql_output_dir

    query_dir = output_dir / query_id

    if not query_dir.exists():
        typer.echo(f"Error: Query directory does not exist: {query_dir}", err=True)
        raise typer.Exit(code=1)

    typer.echo(f"Generating summary for query: {query_id}")
    if threshold is not None:
        typer.echo(f"Threshold: {threshold}")
    typer.echo(f"Query directory: {query_dir}")

    analyzer = CodeQLResultAnalyzer()
    try:
        results = analyzer.generate_summary_from_directory(query_dir, threshold=threshold)
    except FileNotFoundError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1) from e

    filename = f"limit_{threshold}_summary.json" if threshold is not None else "summary.json"
    output_path = query_dir / filename

    analyzer.save_summary_json(query_id, results, output_path, threshold=threshold)

    typer.echo(f"Successfully generated summary: {output_path}")
    typer.echo(f"Total projects: {len(results)}")
    if results:
        typer.echo("\nResults:")
        for project, count in sorted(results.items(), key=lambda x: x[1], reverse=True):
            typer.echo(f"  - {project}: {count} results")
