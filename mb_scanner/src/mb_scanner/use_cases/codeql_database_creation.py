"""CodeQLデータベース作成ワークフローモジュール

このモジュールでは、リポジトリのクローンとCodeQL DB作成を統合した
ワークフローを提供します。
"""

import logging
from pathlib import Path
from typing import Literal, TypedDict

from mb_scanner.domain.ports.codeql_gateway import CodeQLDatabaseManagerPort
from mb_scanner.domain.ports.repository_cloner import RepositoryClonerPort

logger = logging.getLogger(__name__)


class DatabaseCreationSuccessResult(TypedDict):
    """データベース作成成功結果"""

    status: Literal["created", "skipped"]
    db_path: str


class DatabaseCreationErrorResult(TypedDict):
    """データベース作成エラー結果"""

    status: Literal["error"]
    error: str


DatabaseCreationResult = DatabaseCreationSuccessResult | DatabaseCreationErrorResult
"""データベース作成結果

成功時（status="created" または "skipped"）はdb_pathを含み、
エラー時（status="error"）はerrorを含む。
"""


class CodeQLDatabaseCreationWorkflow:
    """CodeQLデータベース作成ワークフロー

    リポジトリのクローンとDB作成を統合します。
    """

    def __init__(
        self,
        cloner: RepositoryClonerPort,
        db_manager: CodeQLDatabaseManagerPort,
        clone_base_dir: Path,
    ) -> None:
        """CodeQLDatabaseCreationWorkflowを初期化する

        Args:
            cloner: RepositoryClonerPort を満たすクローナー
            db_manager: CodeQLDatabaseManagerPort を満たすマネージャー
            clone_base_dir: リポジトリクローン先のベースディレクトリ
        """
        self.cloner = cloner
        self.db_manager = db_manager
        self.clone_base_dir = clone_base_dir

    def create_database_for_project(
        self,
        project_full_name: str,
        repository_url: str,
        language: str = "javascript",
        *,
        skip_if_exists: bool = True,
        force: bool = False,
    ) -> DatabaseCreationResult:
        """プロジェクトのCodeQL DBを作成する

        フロー:
        1. 既存DBのチェック
        2. リポジトリクローン（既存の場合はスキップ）
        3. CodeQL DB作成

        Args:
            project_full_name: プロジェクト名（owner/repo）
            repository_url: リポジトリのURL
            language: 解析言語
            skip_if_exists: 既存DBがある場合スキップするか
            force: 既存DBを上書きするか

        Returns:
            DatabaseCreationResult: 実行結果
                - status: "created" | "skipped" | "error"
                - db_path: 作成されたDBのパス（statusが"created"または"skipped"の場合）
                - error: エラーメッセージ（statusが"error"の場合）
        """
        logger.info("Starting CodeQL DB creation for: %s", project_full_name)

        # 1. 既存DBのチェック
        if skip_if_exists and self.db_manager.database_exists(project_full_name):
            logger.info("Database already exists for %s, skipping", project_full_name)
            return {
                "status": "skipped",
                "db_path": str(self.db_manager.get_database_path(project_full_name)),
            }

        # クローン先のパスを決定
        safe_name = project_full_name.replace("/", "-")
        clone_path = self.clone_base_dir / safe_name

        try:
            # 2. リポジトリクローン（既存の場合はスキップ）
            logger.info("Cloning repository: %s", repository_url)
            self.cloner.clone(repository_url, clone_path, skip_if_exists=True)

            # 3. CodeQL DB作成
            logger.info("Creating CodeQL database for: %s", project_full_name)
            db_path = self.db_manager.create_database(
                project_full_name=project_full_name,
                source_root=clone_path,
                language=language,
                force=force,
            )

            logger.info("Successfully created CodeQL database: %s", db_path)
            return {
                "status": "created",
                "db_path": str(db_path),
            }

        except Exception as e:
            error_msg = f"Failed to create database for {project_full_name}: {e}"
            logger.error(error_msg, exc_info=True)
            return {
                "status": "error",
                "error": str(e),
            }

    def create_databases_batch(
        self,
        projects: list[tuple[int, str, str]],
        language: str = "javascript",
        *,
        skip_if_exists: bool = True,
        force: bool = False,
    ) -> dict[str, int]:
        """複数プロジェクトのDBを一括作成する

        Args:
            projects: [(project_id, full_name, url), ...] のリスト
            language: 解析言語
            skip_if_exists: 既存DBをスキップするか
            force: 既存DBを上書きするか

        Returns:
            dict: 統計情報
                - total: 対象プロジェクト数
                - created: 作成成功数
                - skipped: スキップ数
                - failed: 失敗数
        """
        logger.info("Starting batch CodeQL DB creation for %d projects", len(projects))

        stats = {
            "total": len(projects),
            "created": 0,
            "skipped": 0,
            "failed": 0,
        }

        for project_id, full_name, url in projects:
            logger.info("Processing project %d/%d: %s", project_id, stats["total"], full_name)

            result = self.create_database_for_project(
                project_full_name=full_name,
                repository_url=url,
                language=language,
                skip_if_exists=skip_if_exists,
                force=force,
            )

            # 統計情報を更新
            if result["status"] == "created":
                stats["created"] += 1
            elif result["status"] == "skipped":
                stats["skipped"] += 1
            elif result["status"] == "error":
                stats["failed"] += 1

        logger.info("Batch creation completed. Stats: %s", stats)
        return stats
