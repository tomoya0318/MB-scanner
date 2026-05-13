"""GitHubプロジェクト関連のドメインエンティティ

SQLAlchemy に依存しない純粋な Pydantic モデルとして定義。
ORM との接続は infrastructure/orm/ で行う。
"""

from datetime import datetime

from pydantic import BaseModel, Field


class Topic(BaseModel):
    """GitHubのtopicを表すドメインエンティティ

    Attributes:
        id: 内部ID
        name: topic名
    """

    id: int | None = None
    name: str


class Project(BaseModel):
    """GitHubプロジェクトを表すドメインエンティティ

    Attributes:
        id: 内部ID
        full_name: プロジェクト名（owner/repo形式）
        url: GitHub Web URL
        stars: スター数
        last_commit_date: 最終コミット日時（pushed_at）
        language: 主要言語
        description: プロジェクト説明文
        fetched_at: データ取得日時
        js_lines_count: JavaScriptファイルの総行数
        topics: 関連するTopicのリスト
    """

    id: int | None = None
    full_name: str
    url: str
    stars: int = 0
    last_commit_date: datetime | None = None
    language: str | None = None
    description: str | None = None
    fetched_at: datetime | None = None
    js_lines_count: int | None = None
    topics: list[Topic] = Field(default_factory=list[Topic])
