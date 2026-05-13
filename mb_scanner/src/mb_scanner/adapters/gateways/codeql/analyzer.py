"""CodeQL SARIF結果の分析モジュール

このモジュールでは、CodeQL分析結果（SARIF形式）の分析機能を提供します。
"""

from datetime import UTC, datetime
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class CodeQLResultAnalyzer:
    """CodeQL SARIF結果の分析クラス

    SARIF形式の結果ファイルから検出件数を取得したり、
    閾値によるフィルタリングを行ったりする機能を提供します。
    """

    @staticmethod
    def count_results(sarif_path: Path) -> int:
        """SARIF結果ファイルから検出件数を取得

        Args:
            sarif_path: SARIFファイルのパス

        Returns:
            int: 検出件数

        Raises:
            FileNotFoundError: SARIFファイルが存在しない場合
            ValueError: SARIF形式が不正な場合

        Examples:
            >>> analyzer = CodeQLResultAnalyzer()
            >>> count = analyzer.count_results(Path("results.sarif"))
        """
        if not sarif_path.exists():
            error_msg = f"SARIF file does not exist: {sarif_path}"
            logger.error(error_msg)
            raise FileNotFoundError(error_msg)

        try:
            with sarif_path.open() as f:
                sarif_data = json.load(f)

            # SARIF形式の検証
            if "runs" not in sarif_data or not sarif_data["runs"]:
                error_msg = f"Invalid SARIF format (missing runs): {sarif_path}"
                logger.error(error_msg)
                raise ValueError(error_msg)

            # 最初のrunのresults配列の長さを返す
            results = sarif_data["runs"][0].get("results", [])
            count = len(results)

            logger.debug("Counted %d results in %s", count, sarif_path)
            return count

        except json.JSONDecodeError as e:
            error_msg = f"Invalid SARIF format (JSON decode error): {sarif_path}"
            logger.error(error_msg)
            raise ValueError(error_msg) from e

    @staticmethod
    def filter_projects_by_threshold(
        results: dict[str, Path],
        threshold: int,
    ) -> list[str]:
        """閾値以上の検出があるプロジェクトをフィルタリング

        Args:
            results: プロジェクト名とSARIFパスの辞書
            threshold: 検出件数の閾値

        Returns:
            list[str]: 閾値以上の検出があるプロジェクト名のリスト

        Examples:
            >>> analyzer = CodeQLResultAnalyzer()
            >>> results = {
            ...     "facebook/react": Path("results1.sarif"),
            ...     "microsoft/vscode": Path("results2.sarif"),
            ... }
            >>> filtered = analyzer.filter_projects_by_threshold(results, threshold=10)
        """
        analyzer = CodeQLResultAnalyzer()
        filtered: list[str] = []

        for project_name, sarif_path in results.items():
            count = analyzer.count_results(sarif_path)
            if count >= threshold:
                filtered.append(project_name)
                logger.debug("Project %s has %d results (>= %d)", project_name, count, threshold)
            else:
                logger.debug("Project %s has %d results (< %d)", project_name, count, threshold)

        logger.info("Filtered %d projects with threshold %d", len(filtered), threshold)
        return filtered

    @staticmethod
    def get_summary(results: dict[str, Path]) -> dict[str, int]:
        """全プロジェクトの検出件数サマリーを取得

        Args:
            results: プロジェクト名とSARIFパスの辞書

        Returns:
            dict[str, int]: プロジェクト名と検出件数の辞書

        Examples:
            >>> analyzer = CodeQLResultAnalyzer()
            >>> results = {
            ...     "facebook/react": Path("results1.sarif"),
            ...     "microsoft/vscode": Path("results2.sarif"),
            ... }
            >>> summary = analyzer.get_summary(results)
            >>> print(summary)
            {'facebook/react': 42, 'microsoft/vscode': 15}
        """
        analyzer = CodeQLResultAnalyzer()
        summary = {project: analyzer.count_results(path) for project, path in results.items()}

        logger.info("Generated summary for %d projects", len(summary))
        return summary

    @staticmethod
    def get_summary_sorted(
        results: dict[str, Path],
        reverse: bool = True,
    ) -> list[tuple[str, int]]:
        """検出件数でソートされたサマリーを取得

        Args:
            results: プロジェクト名とSARIFパスの辞書
            reverse: 降順でソート（デフォルト: True）

        Returns:
            list[tuple[str, int]]: (プロジェクト名, 検出件数)のタプルリスト

        Examples:
            >>> analyzer = CodeQLResultAnalyzer()
            >>> results = {
            ...     "facebook/react": Path("results1.sarif"),
            ...     "microsoft/vscode": Path("results2.sarif"),
            ... }
            >>> sorted_summary = analyzer.get_summary_sorted(results)
            >>> print(sorted_summary)
            [('facebook/react', 42), ('microsoft/vscode', 15)]
        """
        analyzer = CodeQLResultAnalyzer()
        summary = analyzer.get_summary(results)

        # 検出件数でソート
        sorted_summary = sorted(summary.items(), key=lambda item: item[1], reverse=reverse)

        logger.info("Sorted summary for %d projects (reverse=%s)", len(sorted_summary), reverse)
        return sorted_summary

    @staticmethod
    def save_summary_json(
        query_id: str,
        results: dict[str, int],
        output_path: Path,
        threshold: int | None = None,
    ) -> None:
        """クエリ実行結果のサマリーをJSON形式で保存

        Args:
            query_id: クエリID（例: "id_10"）
            results: プロジェクト名と検出件数の辞書
            output_path: 出力先パス（summary.jsonのパス）
            threshold: 閾値（指定された場合はJSONに含める）

        Examples:
            >>> analyzer = CodeQLResultAnalyzer()
            >>> results = {"facebook/react": 15, "microsoft/vscode": 8}
            >>> analyzer.save_summary_json("id_10", results, Path("summary.json"))
        """
        # 親ディレクトリを作成
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # サマリーデータを構築
        summary_data: dict[str, str | int | dict[str, int]] = {
            "query_id": query_id,
            "total_projects": len(results),
            "results": results,
            "generated_at": datetime.now(UTC).isoformat(),
        }

        # 閾値が指定されている場合は追加
        if threshold is not None:
            summary_data["threshold"] = threshold

        # JSONファイルとして保存
        with output_path.open("w") as f:
            json.dump(summary_data, f, indent=2, ensure_ascii=False)

        logger.info(
            "Saved summary for query %s to %s (%d projects, threshold=%s)",
            query_id,
            output_path,
            len(results),
            threshold,
        )

    @staticmethod
    def generate_summary_from_directory(
        query_dir: Path,
        threshold: int | None = None,
    ) -> dict[str, int]:
        """クエリディレクトリ内のSARIFファイルから結果を集計

        Args:
            query_dir: クエリディレクトリ（例: outputs/queries/id_10）
            threshold: 閾値（指定された場合、この値以上の結果のみ含める）

        Returns:
            dict[str, int]: プロジェクト名と検出件数の辞書

        Raises:
            FileNotFoundError: ディレクトリが存在しない場合

        Examples:
            >>> analyzer = CodeQLResultAnalyzer()
            >>> summary = analyzer.generate_summary_from_directory(Path("outputs/queries/id_10"))
            >>> print(summary)
            {'facebook/react': 15, 'microsoft/vscode': 8}
        """
        if not query_dir.exists():
            error_msg = f"Query directory does not exist: {query_dir}"
            logger.error(error_msg)
            raise FileNotFoundError(error_msg)

        analyzer = CodeQLResultAnalyzer()
        summary: dict[str, int] = {}

        # ディレクトリ内の全SARIFファイルを検索
        sarif_files = sorted(query_dir.glob("*.sarif"))

        for sarif_path in sarif_files:
            # ファイル名からプロジェクト名を復元（facebook-react.sarif → facebook/react）
            project_name = sarif_path.stem.replace("-", "/", 1)

            # 結果件数をカウント
            try:
                count = analyzer.count_results(sarif_path)

                # 閾値チェック
                if threshold is None or count >= threshold:
                    summary[project_name] = count
                    logger.debug("Added %s: %d results (threshold=%s)", project_name, count, threshold)
                else:
                    logger.debug("Skipped %s: %d results (< threshold %d)", project_name, count, threshold)

            except (FileNotFoundError, ValueError) as e:
                logger.warning("Failed to process %s: %s", sarif_path, e)
                continue

        logger.info(
            "Generated summary from %s: %d projects (threshold=%s)",
            query_dir,
            len(summary),
            threshold,
        )
        return summary
