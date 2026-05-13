"""クエリ結果サマリーのPydanticモデル

このモジュールは datamodel-code-generator によって自動生成され、
AIによって整理されました。

元ファイル: outputs/queries/detect_strict/limit_1_summary.json
生成日時: 2026-01-14
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class QuerySummary(BaseModel):
    """クエリ実行結果のサマリー

    Attributes:
        query_id: クエリの識別子（例: "id_222"）
        total_projects: 対象プロジェクトの総数
        results: リポジトリ名をキー、検出数を値とする辞書
        generated_at: サマリー生成日時（ISO 8601形式）
        threshold: 検出のしきい値（オプショナル）
    """

    query_id: str
    total_projects: int
    results: dict[str, int]
    generated_at: datetime
    threshold: int | None = None
