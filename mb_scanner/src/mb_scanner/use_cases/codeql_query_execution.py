"""CodeQLクエリ実行ワークフローモジュール

このモジュールでは、CodeQLクエリの実行を統合したワークフローを提供します。
"""

import logging
from pathlib import Path
from typing import Literal, TypedDict

from mb_scanner.domain.ports.codeql_gateway import CodeQLCLIPort, CodeQLDatabaseManagerPort, CodeQLResultAnalyzerPort

logger = logging.getLogger(__name__)


class QueryResult(TypedDict):
    """個別クエリの実行結果

    Attributes:
        query_file: クエリファイル名
        output_path: 結果ファイルのパス
        result_count: 検出件数
    """

    query_file: str
    output_path: str
    result_count: int


class QueryExecutionSuccessResult(TypedDict):
    """クエリ実行成功結果"""

    status: Literal["success"]
    results: list[QueryResult]


class QueryExecutionErrorResult(TypedDict):
    """クエリ実行エラー結果"""

    status: Literal["error"]
    error: str


QueryExecutionResult = QueryExecutionSuccessResult | QueryExecutionErrorResult
"""クエリ実行全体の結果

成功時（status="success"）はresultsを含み、
エラー時（status="error"）はerrorを含む。
"""


class CodeQLQueryExecutionWorkflow:
    """CodeQLクエリ実行ワークフロー

    データベース確認、クエリ実行、結果分析を統合します。
    """

    def __init__(
        self,
        codeql_cli: CodeQLCLIPort,
        db_manager: CodeQLDatabaseManagerPort,
        result_analyzer: CodeQLResultAnalyzerPort,
    ) -> None:
        """CodeQLQueryExecutionWorkflowを初期化する

        Args:
            codeql_cli: CodeQLCLIPort を満たすCLI
            db_manager: CodeQLDatabaseManagerPort を満たすマネージャー
            result_analyzer: CodeQLResultAnalyzerPort を満たすアナライザー
        """
        self.codeql_cli = codeql_cli
        self.db_manager = db_manager
        self.result_analyzer = result_analyzer

    def execute_query_for_project(
        self,
        project_full_name: str,
        query_files: list[Path],
        output_base_dir: Path,
        *,
        format: str = "sarifv2.1.0",
        threads: int | None = None,
        ram: int | None = None,
        sarif_category: str | None = None,
        sarif_add_snippets: bool = True,
    ) -> QueryExecutionResult:
        """単一プロジェクトに対してクエリを実行（各クエリファイルごとに別々のSARIFを出力）

        フロー:
        1. データベースの存在確認
        2. クエリファイルの検証
        3. 各クエリファイルごとにクエリ実行
        4. 結果のカウント（オプション）

        Args:
            project_full_name: プロジェクト名（owner/repo）
            query_files: クエリファイルのリスト
            output_base_dir: 結果の出力先ベースディレクトリ
            format: 出力形式
            threads: 使用するスレッド数
            ram: 使用するRAM（MB）
            sarif_category: SARIFカテゴリ
            sarif_add_snippets: コードスニペットを含めるか

        Returns:
            QueryExecutionResult: 実行結果
                - status: "success" | "error"
                - results: クエリごとの結果リスト（成功時）
                - error: エラーメッセージ（エラー時）
        """
        logger.info("Starting CodeQL query execution for: %s", project_full_name)

        try:
            # 1. データベースの存在確認
            if not self.db_manager.database_exists(project_full_name):
                error_msg = f"Database does not exist for project: {project_full_name}"
                logger.error(error_msg)
                return {
                    "status": "error",
                    "error": error_msg,
                }

            db_path = self.db_manager.get_database_path(project_full_name)
            logger.info("Database found: %s", db_path)

            # 2. クエリファイルの検証
            for query_file in query_files:
                if not query_file.exists():
                    error_msg = f"Query file does not exist: {query_file}"
                    logger.error(error_msg)
                    return {
                        "status": "error",
                        "error": error_msg,
                    }

            # 3. 各クエリファイルごとにクエリ実行
            results: list[QueryResult] = []
            safe_project_name = project_full_name.replace("/", "-")

            for query_file in query_files:
                query_name = query_file.stem  # id_10.ql -> id_10
                output_path = output_base_dir / query_name / f"{safe_project_name}.sarif"

                # 出力先ディレクトリを作成
                output_path.parent.mkdir(parents=True, exist_ok=True)

                logger.info("Executing query %s for: %s", query_file.name, project_full_name)

                self.codeql_cli.analyze_database(
                    database_path=db_path,
                    output_path=output_path,
                    query_files=[query_file],  # 1つずつ実行
                    format=format,
                    threads=threads,
                    ram=ram,
                    sarif_category=sarif_category,
                    sarif_add_snippets=sarif_add_snippets,
                )

                # 結果のカウント
                result_count = self.result_analyzer.count_results(output_path)

                results.append(
                    QueryResult(
                        query_file=query_file.name,
                        output_path=str(output_path),
                        result_count=result_count,
                    )
                )

                logger.info(
                    "Successfully executed query %s for %s: %d results found",
                    query_file.name,
                    project_full_name,
                    result_count,
                )

            return {
                "status": "success",
                "results": results,
            }

        except Exception as e:
            error_msg = f"Failed to execute query for {project_full_name}: {e}"
            logger.error(error_msg, exc_info=True)
            return {
                "status": "error",
                "error": str(e),
            }

    def execute_queries_batch(
        self,
        projects: list[str],
        query_files: list[Path],
        output_base_dir: Path,
        *,
        format: str = "sarifv2.1.0",
        threads: int | None = None,
        ram: int | None = None,
    ) -> dict[str, int]:
        """複数プロジェクトに対してクエリを一括実行

        Args:
            projects: プロジェクト名のリスト（例: ["facebook/react", "microsoft/vscode"]）
            query_files: クエリファイルのリスト
            output_base_dir: 結果の出力先ベースディレクトリ
            format: 出力フォーマット
            threads: 使用するスレッド数
            ram: 使用するRAM（MB）

        Returns:
            dict: 統計情報
                - total: 対象プロジェクト数
                - success: 成功数
                - failed: 失敗数
        """
        logger.info("Starting batch CodeQL query execution for %d projects", len(projects))

        stats = {
            "total": len(projects),
            "success": 0,
            "failed": 0,
        }

        for project_name in projects:
            logger.info("Processing project: %s", project_name)

            result = self.execute_query_for_project(
                project_full_name=project_name,
                query_files=query_files,
                output_base_dir=output_base_dir,
                format=format,
                threads=threads,
                ram=ram,
            )

            # 統計情報を更新
            if result["status"] == "success":
                stats["success"] += 1
            else:
                stats["failed"] += 1

        logger.info("Batch execution completed. Stats: %s", stats)
        return stats
