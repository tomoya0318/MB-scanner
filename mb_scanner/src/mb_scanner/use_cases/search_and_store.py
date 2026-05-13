"""リポジトリ検索と保存のワークフローモジュール

このモジュールでは、GitHub APIからリポジトリを検索し、
データベースに保存するワークフローを提供します。
"""

import logging

from mb_scanner.domain.ports.github_gateway import GitHubGateway, GitHubRepositoryDTO, SearchCriteria
from mb_scanner.domain.ports.project_repository import ProjectRepository

logger = logging.getLogger(__name__)


class SearchAndStoreWorkflow:
    """GitHub検索とDB保存を統合するワークフロークラス

    GitHubGatewayとProjectRepositoryを連携させ、
    検索結果をデータベースに保存します。

    Attributes:
        github_client: GitHub APIクライアント（GitHubGateway Protocol）
        project_repo: プロジェクトリポジトリ（ProjectRepository Protocol）
    """

    def __init__(self, github_client: GitHubGateway, project_repo: ProjectRepository) -> None:
        """SearchAndStoreWorkflowを初期化する

        Args:
            github_client: GitHubGateway Protocol を満たすクライアント
            project_repo: ProjectRepository Protocol を満たすリポジトリ
        """
        self.github_client = github_client
        self.project_repo = project_repo

    def execute(
        self,
        criteria: SearchCriteria,
        max_results: int | None = None,
        *,
        update_if_exists: bool = False,
    ) -> dict[str, int]:
        """検索条件に基づいてリポジトリを検索し、データベースに保存する

        Args:
            criteria: 検索条件
            max_results: 取得する最大リポジトリ数
            update_if_exists: 既存プロジェクトを更新するか（デフォルト: False）

        Returns:
            dict[str, int]: 実行結果の統計情報
                - total: 検索結果の総数
                - saved: 保存に成功した数
                - updated: 更新した数
                - skipped: スキップした数（既存）
                - failed: 保存に失敗した数

        Raises:
            Exception: GitHub API呼び出しまたはDB保存でエラーが発生した場合
        """
        logger.info("Starting search and store workflow with criteria: %s", criteria)

        # 統計情報を初期化
        stats = {
            "total": 0,
            "saved": 0,
            "updated": 0,
            "skipped": 0,
            "failed": 0,
        }

        try:
            # GitHub APIで検索実行
            repositories = self.github_client.search_repositories(
                criteria=criteria,
                max_results=max_results,
            )
            stats["total"] = len(repositories)

            logger.info("Found %d repositories, starting to save...", stats["total"])

            # 各リポジトリをデータベースに保存
            for repo in repositories:
                try:
                    result = self._save_repository(repo, update_if_exists=update_if_exists)

                    # 統計情報を更新
                    if result == "new":
                        stats["saved"] += 1
                    elif result == "updated":
                        stats["updated"] += 1
                    elif result == "skipped":
                        stats["skipped"] += 1

                except Exception as e:
                    logger.error("Failed to save repository %s: %s", repo.full_name, e)
                    stats["failed"] += 1
                    continue

            logger.info("Workflow completed. Stats: %s", stats)
            return stats

        except Exception as e:
            logger.error("Workflow failed: %s", e)
            raise

    def _save_repository(
        self,
        repo: GitHubRepositoryDTO,
        *,
        update_if_exists: bool,
    ) -> str:
        """リポジトリをデータベースに保存する

        Args:
            repo: GitHubRepositoryDTOオブジェクト
            update_if_exists: 既存プロジェクトを更新するか

        Returns:
            str: "new" (新規保存), "updated" (更新), "skipped" (スキップ) のいずれか
        """
        # 既存のプロジェクトをチェック
        existing_project = self.project_repo.get_project_by_full_name(repo.full_name)

        # 既存プロジェクトがあり、更新フラグがFalseなら、スキップ
        if existing_project and not update_if_exists:
            logger.debug("Skipped existing project: %s", repo.full_name)
            return "skipped"

        # ProjectRepositoryを使って保存
        self.project_repo.save_project(
            full_name=repo.full_name,
            url=repo.html_url,
            stars=repo.stargazers_count,
            language=repo.language,
            description=repo.description,
            last_commit_date=repo.pushed_at,
            topics=repo.topics,
            update_if_exists=update_if_exists,
        )

        # 既存プロジェクトがあれば更新、なければ新規保存
        if existing_project:
            logger.debug("Updated project: %s", repo.full_name)
            return "updated"

        logger.debug("Saved new project: %s", repo.full_name)
        return "new"

    def close(self) -> None:
        """リソースをクリーンアップする"""
        self.github_client.close()
        logger.info("SearchAndStoreWorkflow closed")
