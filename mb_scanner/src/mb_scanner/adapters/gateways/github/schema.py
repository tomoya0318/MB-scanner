"""GitHub APIレスポンスのPydanticスキーマ

このモジュールでは、GitHub APIから取得したデータを型安全に扱うための
Pydanticモデルを定義します。
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from github.Repository import RepositorySearchResult


class GitHubRepository(BaseModel):
    """GitHubリポジトリの情報を表すPydanticモデル

    PyGithubのRepositoryオブジェクトから変換されたデータを保持します。

    Attributes:
        full_name: リポジトリ名（owner/repo形式）
        html_url: GitHub Web URL
        stargazers_count: スター数
        pushed_at: 最終push日時
        language: 主要言語
        description: リポジトリ説明文
        topics: topicのリスト
    """

    full_name: str = Field(..., description="リポジトリ名（owner/repo形式）")
    html_url: str = Field(..., description="GitHub Web URL")
    stargazers_count: int = Field(..., ge=0, description="スター数")
    pushed_at: datetime | None = Field(None, description="最終push日時")
    language: str | None = Field(None, description="主要言語")
    description: str | None = Field(None, description="リポジトリ説明文")
    topics: list[str] = Field(default_factory=list, description="topicのリスト")

    @classmethod
    def from_pygithub(cls, repo: RepositorySearchResult) -> GitHubRepository:
        """PyGithubのRepositoryオブジェクトからGitHubRepositoryを作成する

        Args:
            repo: github.Repository.Repository オブジェクト

        Returns:
            GitHubRepository: 変換されたPydanticモデル
        """
        return cls(
            full_name=repo.full_name,
            html_url=repo.html_url,
            stargazers_count=repo.stargazers_count,
            pushed_at=repo.pushed_at,
            language=repo.language,
            description=repo.description,
            topics=repo.get_topics(),
        )
