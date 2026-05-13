"""トピックリポジトリの契約定義"""

from typing import Protocol

from mb_scanner.domain.entities.project import Topic


class TopicRepository(Protocol):
    """Topic の CRUD 操作を定義するポート"""

    def get_topic_by_name(self, name: str) -> Topic | None: ...

    def get_all_topics(self) -> list[Topic]: ...

    def count_topics(self) -> int: ...

    def get_or_create_topics(self, topic_names: list[str]) -> list[Topic]: ...
