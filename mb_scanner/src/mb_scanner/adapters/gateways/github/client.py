"""GitHub API クライアントモジュール

このモジュールでは、PyGithubをラップしたGitHub APIクライアントを提供します。
認証管理、検索機能、エラーハンドリングを担当します。
"""

from __future__ import annotations

from datetime import UTC, datetime
import logging
from typing import cast

from github import Auth, Github, GithubException, RateLimitExceededException
from github.Repository import RepositorySearchResult

from mb_scanner.adapters.gateways.github.search import build_default_search_criteria
from mb_scanner.domain.ports.github_gateway import GitHubRepositoryDTO, SearchCriteria
from mb_scanner.infrastructure.config import settings

logger = logging.getLogger(__name__)


class GitHubClient:
    """GitHub APIクライアント

    PyGithubをラップし、認証管理と検索機能を提供します。

    Attributes:
        github: PyGithubのGithubクライアントインスタンス
    """

    def __init__(self, token: str | None = None) -> None:
        """GitHubClientを初期化する

        Args:
            token: GitHub APIトークン。指定されない場合は設定から取得します。

        Raises:
            ValueError: トークンが指定されておらず、設定にも存在しない場合
        """
        self.token = token or settings.github_token

        if not self.token:
            msg = "GitHub token is not configured. Set GITHUB_TOKEN environment variable."
            raise ValueError(msg)

        # PyGithubクライアントを初期化
        auth = Auth.Token(self.token)
        self.github = Github(auth=auth)

        logger.info("GitHubClient initialized successfully")

    def search_repositories(
        self,
        criteria: SearchCriteria | None = None,
        max_results: int | None = None,
    ) -> list[GitHubRepositoryDTO]:
        """検索条件に基づいてリポジトリを検索する

        Args:
            criteria: 検索条件。指定されない場合は設定からデフォルト値を読み込みます。
            max_results: 取得する最大リポジトリ数（指定されない場合は全件取得）

        Returns:
            list[GitHubRepositoryDTO]: 検索結果のリポジトリリスト

        Raises:
            RateLimitExceededException: APIレート制限を超えた場合
            GithubException: GitHub API呼び出しでエラーが発生した場合
        """
        # デフォルト検索条件を適用
        if criteria is None:
            criteria = build_default_search_criteria()

        try:
            # 検索クエリを構築
            query = criteria.to_query_string()
            logger.info("Searching repositories with query: %s", query)

            # PyGithubで検索実行
            repositories = self.github.search_repositories(query=query)

            # 結果を変換
            results: list[GitHubRepositoryDTO] = []
            repo_iterator = repositories[:max_results] if max_results is not None else repositories
            for repo_item in repo_iterator:
                try:
                    repo = cast(RepositorySearchResult, repo_item)
                    dto = GitHubRepositoryDTO(
                        full_name=repo.full_name,
                        html_url=repo.html_url,
                        stargazers_count=repo.stargazers_count,
                        pushed_at=repo.pushed_at,
                        language=repo.language,
                        description=repo.description,
                        topics=repo.get_topics(),
                    )
                    results.append(dto)
                    logger.debug("Fetched repository: %s", dto.full_name)
                except Exception as e:
                    logger.warning("Failed to convert repository item %r: %s", repo_item, e)
                    continue

            logger.info("Successfully fetched %d repositories", len(results))
            return results

        except RateLimitExceededException as e:
            logger.error("GitHub API rate limit exceeded: %s", e)
            raise
        except GithubException as e:
            logger.error("GitHub API error: %s", e)
            raise
        except Exception as e:
            logger.error("Unexpected error during repository search: %s", e)
            raise

    def get_rate_limit_info(self) -> dict[str, int | float | datetime]:
        """APIレート制限の情報を取得し、待機に必要な情報も計算する

        Returns:
            dict[str, int]: レート制限情報
                - limit: 1時間あたりの最大リクエスト数
                - remaining: 残りのリクエスト数
                - reset_time (datetime): 制限がリセットされる時刻 (UTC)
                - wait_seconds (float): リセットまでの待機秒数 (残りがない場合)
        """
        overview = self.github.get_rate_limit()
        core_limit = overview.resources.core

        wait_seconds = 0.0
        # 残りリクエスト数が0の場合のみ、待機秒数を計算
        if core_limit.remaining == 0:
            now_utc = datetime.now(UTC)
            # リセット時刻と現在時刻の差分を秒で取得
            delta = core_limit.reset - now_utc
            # 念のためマイナスにならないようにmaxで制御
            wait_seconds = max(0, delta.total_seconds())

        return {
            "limit": core_limit.limit,
            "remaining": core_limit.remaining,
            "reset_time": core_limit.reset,
            "wait_seconds": wait_seconds,
        }

    def close(self) -> None:
        """GitHubクライアントを閉じる"""
        self.github.close()
        logger.info("GitHubClient closed")
