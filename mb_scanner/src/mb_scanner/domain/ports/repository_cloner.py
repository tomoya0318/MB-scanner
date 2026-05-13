"""リポジトリクローナーの契約定義"""

from pathlib import Path
from typing import Protocol


class RepositoryClonerPort(Protocol):
    """リポジトリクローン操作の契約"""

    def clone(
        self,
        repository_url: str,
        destination: Path,
        *,
        skip_if_exists: bool = False,
    ) -> Path: ...
