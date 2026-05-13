"""CodeQL ゲートウェイの契約定義"""

from pathlib import Path
from typing import Protocol


class CodeQLCLIPort(Protocol):
    """CodeQL CLI 操作の契約"""

    def analyze_database(
        self,
        database_path: Path,
        output_path: Path,
        *,
        query_files: list[Path] | None = None,
        format: str = "sarifv2.1.0",
        threads: int | None = None,
        ram: int | None = None,
        sarif_category: str | None = None,
        sarif_add_snippets: bool = True,
    ) -> None: ...


class CodeQLDatabaseManagerPort(Protocol):
    """CodeQL データベース管理の契約"""

    def database_exists(self, project_full_name: str) -> bool: ...

    def get_database_path(self, project_full_name: str) -> Path: ...

    def create_database(
        self,
        project_full_name: str,
        source_root: Path,
        language: str,
        *,
        force: bool = False,
    ) -> Path: ...


class CodeQLResultAnalyzerPort(Protocol):
    """CodeQL 結果分析の契約"""

    def count_results(self, sarif_path: Path) -> int: ...
