"""TopicRepository の SQLAlchemy 実装"""

from sqlalchemy.orm import Session

from mb_scanner.domain.entities.project import Topic
from mb_scanner.infrastructure.orm.tables import TopicORM


class SqlAlchemyTopicRepository:
    """TopicRepository Protocol の SQLAlchemy 実装"""

    def __init__(self, db: Session) -> None:
        self.db = db

    @staticmethod
    def _to_domain(orm: TopicORM) -> Topic:
        return Topic(id=orm.id, name=orm.name)

    def get_topic_by_name(self, name: str) -> Topic | None:
        orm = self.db.query(TopicORM).filter(TopicORM.name == name).first()
        if orm is None:
            return None
        return self._to_domain(orm)

    def get_all_topics(self) -> list[Topic]:
        return [self._to_domain(orm) for orm in self.db.query(TopicORM).all()]

    def count_topics(self) -> int:
        return self.db.query(TopicORM).count()

    def get_or_create_topics(self, topic_names: list[str]) -> list[Topic]:
        orms: list[TopicORM] = []
        for name in topic_names:
            orm = self.db.query(TopicORM).filter(TopicORM.name == name).first()
            if not orm:
                orm = TopicORM(name=name)
                self.db.add(orm)
            orms.append(orm)
        self.db.flush()
        return [self._to_domain(orm) for orm in orms]
