"""GitHub API ゲートウェイの契約定義"""

from datetime import UTC, datetime, timedelta
from typing import Protocol

from pydantic import BaseModel, Field


class SearchCriteria(BaseModel):
    """GitHub検索条件を表すPydanticモデル

    Attributes:
        language: 検索対象の主要言語
        min_stars: 最小スター数
        max_days_since_commit: 最終コミットからの最大日数
    """

    language: str = Field(..., description="検索対象の主要言語")
    min_stars: int = Field(..., ge=0, description="最小スター数")
    max_days_since_commit: int = Field(..., ge=1, description="最終コミットからの最大日数")

    def to_query_string(self) -> str:
        """検索条件をGitHub検索クエリ文字列に変換する

        例: "language:javascript stars:>=100 pushed:>2024-01-01"

        Returns:
            str: GitHub API用の検索クエリ文字列
        """
        cutoff_date = datetime.now(UTC) - timedelta(days=self.max_days_since_commit)
        date_str = cutoff_date.strftime("%Y-%m-%d")

        query_parts = [
            f"language:{self.language.lower()}",
            f"stars:>={self.min_stars}",
            f"pushed:>{date_str}",
        ]

        return " ".join(query_parts)


class GitHubRepositoryDTO(BaseModel):
    """GitHub API から取得したリポジトリ情報"""

    full_name: str = Field(..., description="リポジトリ名（owner/repo形式）")
    html_url: str = Field(..., description="GitHub Web URL")
    stargazers_count: int = Field(..., ge=0, description="スター数")
    pushed_at: datetime | None = Field(None, description="最終push日時")
    language: str | None = Field(None, description="主要言語")
    description: str | None = Field(None, description="リポジトリ説明文")
    topics: list[str] = Field(default_factory=list, description="topicのリスト")


class GitHubGateway(Protocol):
    """GitHub API 操作の契約"""

    def search_repositories(
        self,
        criteria: SearchCriteria,
        max_results: int | None = None,
    ) -> list[GitHubRepositoryDTO]: ...

    def close(self) -> None: ...
