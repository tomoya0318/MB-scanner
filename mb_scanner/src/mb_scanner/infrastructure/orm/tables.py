"""GitHubプロジェクト関連のORMモデル

SQLAlchemy Declarative モデルとしてテーブルを定義。
domain/entities/ のドメインエンティティとの変換は repositories が担当する。
"""

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from mb_scanner.infrastructure.orm.base import Base


class ProjectORM(Base):
    """GitHubプロジェクトのORMモデル"""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    full_name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    url: Mapped[str] = mapped_column(String(500), nullable=False)
    stars: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    last_commit_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    language: Mapped[str | None] = mapped_column(String(50), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=lambda: datetime.now(UTC))
    js_lines_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    topics: Mapped[list["TopicORM"]] = relationship(
        "TopicORM", secondary="project_topics", back_populates="projects", lazy="selectin"
    )

    def __repr__(self) -> str:
        return f"<ProjectORM(id={self.id}, full_name='{self.full_name}', stars={self.stars})>"


class TopicORM(Base):
    """GitHubのtopicのORMモデル"""

    __tablename__ = "topics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)

    projects: Mapped[list["ProjectORM"]] = relationship(
        "ProjectORM", secondary="project_topics", back_populates="topics", lazy="selectin"
    )

    def __repr__(self) -> str:
        return f"<TopicORM(id={self.id}, name='{self.name}')>"


class ProjectTopicORM(Base):
    """プロジェクトとtopicの多対多関係を表す中間テーブル"""

    __tablename__ = "project_topics"

    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    topic_id: Mapped[int] = mapped_column(Integer, ForeignKey("topics.id", ondelete="CASCADE"), primary_key=True)
