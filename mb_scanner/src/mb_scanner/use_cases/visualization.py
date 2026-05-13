"""可視化用のデータ取得・結合サービス

このモジュールでは、CodeQLクエリ結果とプロジェクトデータを結合して、
可視化に必要なデータを提供します。
"""

from pathlib import Path

from mb_scanner.domain.entities import QuerySummary
from mb_scanner.domain.ports.project_repository import ProjectRepository


class VisualizationService:
    """可視化用データを提供するサービスクラス

    JSONファイルからCodeQLクエリ結果を読み込み、
    データベースからプロジェクト情報を取得して結合します。
    """

    def __init__(self, project_repo: ProjectRepository) -> None:
        """VisualizationServiceを初期化する

        Args:
            project_repo: ProjectRepository Protocol を満たすリポジトリ
        """
        self.project_repo = project_repo

    def load_query_results(self, json_path: Path) -> QuerySummary:
        """JSONファイルからクエリ結果を読み込む

        Args:
            json_path: クエリ結果のJSONファイルパス

        Returns:
            QuerySummary: クエリ結果のPydanticモデル

        Raises:
            FileNotFoundError: ファイルが存在しない場合
            pydantic.ValidationError: JSONのパースに失敗した場合
        """
        if not json_path.exists():
            msg = f"File not found: {json_path}"
            raise FileNotFoundError(msg)

        with json_path.open("rb") as f:
            return QuerySummary.model_validate_json(f.read())

    def get_scatter_data(self, json_path: Path) -> list[tuple[int, int, str]]:
        """散布図用のデータを取得する

        JSONファイルからクエリ結果を読み込み、データベースから対応する
        プロジェクトのjs_lines_countを取得して結合します。

        Args:
            json_path: クエリ結果のJSONファイルパス

        Returns:
            list[tuple[int, int, str]]: (js_lines_count, detection_count, full_name)のリスト
            js_lines_countがNullのプロジェクトやDBに存在しないプロジェクトはスキップされます。
        """
        # JSONファイルからクエリ結果を読み込む
        query_summary = self.load_query_results(json_path)

        scatter_data: list[tuple[int, int, str]] = []

        # 各プロジェクトの結果を処理
        for full_name, detection_count in query_summary.results.items():
            # データベースからプロジェクトを取得
            project = self.project_repo.get_project_by_full_name(full_name)

            # プロジェクトが存在しない、またはjs_lines_countがNullの場合はスキップ
            if project is None or project.js_lines_count is None:
                continue

            # データを追加
            scatter_data.append((project.js_lines_count, detection_count, full_name))

        return scatter_data
