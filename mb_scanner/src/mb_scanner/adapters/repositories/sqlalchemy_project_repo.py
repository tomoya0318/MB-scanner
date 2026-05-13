"""ProjectRepository の SQLAlchemy 実装"""

from datetime import UTC, datetime

from sqlalchemy.orm import Session

from mb_scanner.adapters.repositories.sqlalchemy_topic_repo import SqlAlchemyTopicRepository
from mb_scanner.domain.entities.project import Project, Topic
from mb_scanner.infrastructure.orm.tables import ProjectORM, TopicORM


class SqlAlchemyProjectRepository:
    """ProjectRepository Protocol の SQLAlchemy 実装"""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.topic_repo = SqlAlchemyTopicRepository(db)

    @staticmethod
    def _to_domain(orm: ProjectORM) -> Project:
        """ORM モデルからドメインエンティティに変換"""
        return Project(
            id=orm.id,
            full_name=orm.full_name,
            url=orm.url,
            stars=orm.stars,
            last_commit_date=orm.last_commit_date,
            language=orm.language,
            description=orm.description,
            fetched_at=orm.fetched_at,
            js_lines_count=orm.js_lines_count,
            topics=[Topic(id=t.id, name=t.name) for t in orm.topics],
        )

    def get_project_by_full_name(self, full_name: str) -> Project | None:
        orm = self.db.query(ProjectORM).filter(ProjectORM.full_name == full_name).first()
        if orm is None:
            return None
        return self._to_domain(orm)

    def get_all_projects(self) -> list[Project]:
        return [self._to_domain(orm) for orm in self.db.query(ProjectORM).all()]

    def count_projects(self) -> int:
        return self.db.query(ProjectORM).count()

    def get_all_project_urls(self) -> list[tuple[int, str, str]]:
        rows = self.db.query(ProjectORM.id, ProjectORM.full_name, ProjectORM.url).all()
        return [(r.id, r.full_name, r.url) for r in rows]

    def save_project(
        self,
        full_name: str,
        url: str,
        stars: int,
        language: str | None,
        description: str | None,
        last_commit_date: datetime | None,
        topics: list[str] | None = None,
        *,
        update_if_exists: bool = False,
    ) -> Project:
        existing = self.db.query(ProjectORM).filter(ProjectORM.full_name == full_name).first()

        if existing:
            if update_if_exists:
                existing.url = url
                existing.stars = stars
                existing.language = language
                existing.description = description
                existing.last_commit_date = last_commit_date
                existing.fetched_at = datetime.now(UTC)

                if topics:
                    existing.topics = self._get_or_create_topic_orms(topics)

                self.db.commit()
                self.db.refresh(existing)
            return self._to_domain(existing)

        new_orm = ProjectORM(
            full_name=full_name,
            url=url,
            stars=stars,
            language=language,
            description=description,
            last_commit_date=last_commit_date,
            fetched_at=datetime.now(UTC),
        )

        if topics:
            new_orm.topics = self._get_or_create_topic_orms(topics)

        self.db.add(new_orm)
        self.db.commit()
        self.db.refresh(new_orm)
        return self._to_domain(new_orm)

    def update_js_lines_count(self, project_id: int, js_lines_count: int) -> None:
        if js_lines_count < 0:
            msg = "js_lines_count must be non-negative"
            raise ValueError(msg)

        project = self.db.query(ProjectORM).filter(ProjectORM.id == project_id).first()
        if not project:
            msg = f"Project with id {project_id} not found"
            raise ValueError(msg)

        project.js_lines_count = js_lines_count
        self.db.commit()

    def _get_or_create_topic_orms(self, topic_names: list[str]) -> list[TopicORM]:
        """Topic 名のリストから ORM オブジェクトを取得または作成する"""
        result: list[TopicORM] = []
        for name in topic_names:
            orm = self.db.query(TopicORM).filter(TopicORM.name == name).first()
            if not orm:
                orm = TopicORM(name=name)
                self.db.add(orm)
            result.append(orm)
        self.db.flush()
        return result
