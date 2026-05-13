"""コード抽出結果のPydanticモデル

このモジュールは datamodel-code-generator によって自動生成され、
AIによって整理されました。

元ファイル: outputs/extracted_code/tmp.json
生成日時: 2026-01-14
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class CodeExtractionMetadata(BaseModel):
    """抽出処理のメタデータ"""

    sarif_path: str
    """元となったSARIFファイルのパス"""

    repository_path: str
    """解析対象リポジトリのパス"""

    total_results: int
    """抽出された結果の総数"""

    extraction_date: datetime
    """抽出を実行した日時"""


class CodeExtractionItem(BaseModel):
    """抽出されたコードスニペット"""

    id: int
    """一意の識別子"""

    file_path: str
    """ソースファイルのパス"""

    start_line: int
    """開始行番号"""

    end_line: int
    """終了行番号"""

    start_column: int | None = None
    """開始カラム位置（Noneの場合は行全体）"""

    end_column: int | None = None
    """終了カラム位置（Noneの場合は行全体）"""

    message: str
    """検出結果のメッセージ"""

    severity: str
    """深刻度（warning, error, noteなど）"""

    code_snippet: str
    """抽出されたコードスニペット"""


class CodeExtractionOutput(BaseModel):
    """コード抽出結果の全体構造"""

    metadata: CodeExtractionMetadata
    """抽出処理のメタデータ"""

    results: list[CodeExtractionItem]
    """抽出されたコードのリスト"""


class CodeExtractionJobResult(BaseModel):
    """コード抽出バッチ処理の結果

    extract_code_for_project() の戻り値。

    Attributes:
        status: 処理ステータス ("success" | "error" | "skipped")
        project: プロジェクト名
        output_path: 出力ファイルパス（成功時）
        result_count: 抽出したコード数（成功時）
        error: エラーメッセージ（エラー時）
    """

    status: Literal["success", "error", "skipped"]
    """処理ステータス"""

    project: str
    """プロジェクト名"""

    output_path: str | None = None
    """出力ファイルパス（成功時）"""

    result_count: int | None = None
    """抽出したコード数（成功時）"""

    error: str | None = None
    """エラーメッセージ（エラー時）"""
