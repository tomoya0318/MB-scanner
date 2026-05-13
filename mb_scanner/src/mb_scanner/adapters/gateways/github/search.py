"""GitHub検索機能のモジュール

このモジュールでは、GitHub API検索用のデフォルト検索条件を提供します。
SearchCriteria は domain/ports/github_gateway.py に定義されています。
"""

from mb_scanner.domain.ports.github_gateway import SearchCriteria
from mb_scanner.infrastructure.config import settings


def build_default_search_criteria() -> SearchCriteria:
    """デフォルトの検索条件をconfigから読み込み、作成する

    タスク仕様に基づくデフォルト値：
    - 主要言語
    - スター数
    - 最終コミット

    Returns:
        SearchCriteria: デフォルトの検索条件
    """
    return SearchCriteria(
        language=settings.github_search_default_language,
        min_stars=settings.github_search_default_min_stars,
        max_days_since_commit=settings.github_search_default_max_days_since_commit,
    )


__all__ = ["SearchCriteria", "build_default_search_criteria"]
