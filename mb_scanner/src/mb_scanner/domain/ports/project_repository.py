"""プロジェクトリポジトリの契約定義"""

from datetime import datetime
from typing import Protocol

from mb_scanner.domain.entities.project import Project


class ProjectRepository(Protocol):
    """Project の CRUD 操作を定義するポート"""

    def get_project_by_full_name(self, full_name: str) -> Project | None: ...

    def get_all_projects(self) -> list[Project]: ...

    def count_projects(self) -> int: ...

    def get_all_project_urls(self) -> list[tuple[int, str, str]]: ...

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
    ) -> Project: ...

    def update_js_lines_count(self, project_id: int, js_lines_count: int) -> None: ...
