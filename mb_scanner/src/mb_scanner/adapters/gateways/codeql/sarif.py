"""SARIF解析とコード抽出機能

CodeQLのSARIF出力ファイルを解析し、検出されたコードの位置情報を取得して、
実際のリポジトリからコードスニペットを抽出する機能を提供します。
"""

from datetime import datetime
import logging
from pathlib import Path
from urllib.parse import unquote

from mb_scanner.domain.entities import (
    CodeExtractionItem,
    CodeExtractionJobResult,
    CodeExtractionMetadata,
    CodeExtractionOutput,
    SarifFinding,
    SarifReport,
)

logger = logging.getLogger(__name__)


class SarifExtractor:
    """SARIF解析とコード抽出のメインクラス

    SARIFファイルを解析し、検出されたコードの位置情報から実際のコードスニペットを抽出します。
    """

    def __init__(self, sarif_path: Path, repository_path: Path):
        """SarifExtractorを初期化

        Args:
            sarif_path: SARIFファイルのパス
            repository_path: リポジトリのルートパス
        """
        self.sarif_path = sarif_path
        self.repository_path = repository_path

    def parse_sarif(self) -> list[SarifFinding]:
        """SARIFファイルを解析して結果リストを取得

        Returns:
            SarifFindingのリスト

        Raises:
            FileNotFoundError: SARIFファイルが存在しない場合
            pydantic.ValidationError: SARIFファイルが不正な形式の場合
        """
        if not self.sarif_path.exists():
            raise FileNotFoundError(f"SARIF file not found: {self.sarif_path}")

        # Pydanticモデルを使用してSARIFファイルを読み込み
        with self.sarif_path.open("rb") as f:
            sarif_data = SarifReport.model_validate_json(f.read())

        results: list[SarifFinding] = []

        if not sarif_data.runs:
            logger.warning("No runs found in SARIF file")
            return results

        # 最初のrunのresultsを取得
        sarif_results = sarif_data.runs[0].results

        for idx, result in enumerate(sarif_results):
            # メッセージの取得
            message_text = result.message.text

            # 深刻度の取得
            severity = result.level or "warning"

            # 位置情報の取得
            if not result.locations:
                logger.warning(f"Result {idx} has no locations, skipping")
                continue

            physical_location = result.locations[0].physicalLocation
            artifact_location = physical_location.artifactLocation
            region = physical_location.region

            # ファイルパスの取得
            file_uri = artifact_location.uri
            # URLエンコードされている場合はデコード
            file_uri = unquote(file_uri)

            # 行・列情報の取得
            if region is None:
                logger.warning(f"Result {idx} has no region, skipping")
                continue

            start_line = region.startLine
            end_line = region.endLine
            start_column = region.startColumn
            end_column = region.endColumn

            # endLineが省略されている場合はstartLineと同じ行とみなす（SARIF仕様）
            if end_line is None:
                end_line = start_line

            sarif_finding = SarifFinding(
                id=idx,
                file_path=file_uri,
                start_line=start_line,
                end_line=end_line,
                start_column=start_column,
                end_column=end_column,
                message=message_text,
                severity=severity,
            )

            results.append(sarif_finding)

        return results

    def extract_code_snippet(self, result: SarifFinding) -> str:
        """位置情報から実際のコードスニペットを抽出

        Args:
            result: SarifFinding オブジェクト

        Returns:
            コードスニペット（複数行の場合は改行で結合）
        """
        # ビルド成果物ディレクトリを除外
        excluded_patterns = [
            "build/",
            "dist/",
            "out/",
            ".next/",
            "target/",
            "public/build/",
            "static/build/",
        ]
        if any(result.file_path.startswith(pattern) for pattern in excluded_patterns):
            logger.debug(f"Skipping build artifact: {result.file_path}")
            return "[Build artifact - skipped]"

        file_path = self.repository_path / result.file_path

        # ファイルの存在確認
        if not file_path.exists():
            logger.warning(f"File not found: {file_path}")
            return "[File not found]"

        try:
            # UTF-8でデコードできない場合はエラーを無視してデコード
            with file_path.open(encoding="utf-8", errors="replace") as f:
                lines = f.readlines()

            # 行番号は1始まりなので、インデックスは0始まりに変換
            start_idx = result.start_line - 1
            end_idx = result.end_line  # end_lineは含むので+1不要

            # 範囲チェック
            if start_idx < 0 or end_idx > len(lines):
                logger.warning(
                    f"Line range out of bounds: {result.start_line}-{result.end_line}, file has {len(lines)} lines"
                )
                return "[Line out of range]"

            # 該当行を抽出
            snippet_lines = lines[start_idx:end_idx]

            # 改行文字を除去して結合
            snippet = "".join(line.rstrip("\n") for line in snippet_lines)
            # 複数行の場合は改行で結合
            if len(snippet_lines) > 1:
                snippet = "\n".join(line.rstrip("\n") for line in snippet_lines)
            else:
                snippet = snippet_lines[0].rstrip("\n") if snippet_lines else ""

            return snippet

        except Exception as e:
            logger.error(f"Error extracting code snippet from {file_path}: {e}")
            return f"[Error: {e}]"

    def extract_all(self) -> CodeExtractionOutput:
        """全ての結果を抽出してCodeExtractionOutputで返す

        Returns:
            CodeExtractionOutput: メタデータと結果を含むPydanticモデル
        """
        # SARIFファイルを解析
        results = self.parse_sarif()

        # メタデータの生成
        metadata = CodeExtractionMetadata(
            sarif_path=str(self.sarif_path),
            repository_path=str(self.repository_path),
            total_results=len(results),
            extraction_date=datetime.now(),
        )

        # 各結果にコードスニペットを追加
        output_results: list[CodeExtractionItem] = []
        for result in results:
            code_snippet = self.extract_code_snippet(result)

            item = CodeExtractionItem(
                id=result.id,
                file_path=result.file_path,
                start_line=result.start_line,
                end_line=result.end_line,
                start_column=result.start_column,
                end_column=result.end_column,
                message=result.message,
                severity=result.severity,
                code_snippet=code_snippet,
            )

            output_results.append(item)

        return CodeExtractionOutput(metadata=metadata, results=output_results)


def extract_code_for_project(
    query_id: str,
    project_name: str,
    sarif_base_dir: Path,
    repository_base_dir: Path,
    output_base_dir: Path,
) -> CodeExtractionJobResult:
    """単一プロジェクトのコード抽出を実行（並列処理用）

    Args:
        query_id: クエリID
        project_name: プロジェクト名
        sarif_base_dir: SARIFファイルのベースディレクトリ
        repository_base_dir: リポジトリのベースディレクトリ
        output_base_dir: 出力先ベースディレクトリ

    Returns:
        CodeExtractionJobResult: 処理結果
            - status: "success" | "error" | "skipped"
            - project: プロジェクト名
            - output_path: 出力ファイルパス（成功時）
            - result_count: 抽出したコード数（成功時）
            - error: エラーメッセージ（エラー時）
    """
    # プロジェクト名をファイルシステム用に変換（/ を - に置換）
    fs_safe_name = project_name.replace("/", "-")

    # パスの構築
    sarif_path = sarif_base_dir / query_id / f"{fs_safe_name}.sarif"
    repository_path = repository_base_dir / fs_safe_name
    output_path = output_base_dir / query_id / f"{fs_safe_name}_code.json"

    try:
        # SARIFファイルの存在確認
        if not sarif_path.exists():
            logger.warning(f"SARIF file not found for {project_name}: {sarif_path}")
            return CodeExtractionJobResult(
                status="skipped",
                project=project_name,
                output_path=None,
                result_count=None,
                error=f"SARIF file not found: {sarif_path}",
            )

        # リポジトリの存在確認
        if not repository_path.exists():
            logger.warning(f"Repository not found for {project_name}: {repository_path}")
            return CodeExtractionJobResult(
                status="skipped",
                project=project_name,
                output_path=None,
                result_count=None,
                error=f"Repository not found: {repository_path}",
            )

        # コード抽出を実行
        extractor = SarifExtractor(sarif_path=sarif_path, repository_path=repository_path)
        extraction_output = extractor.extract_all()

        # 出力ディレクトリを作成
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # JSONファイルに保存（Pydanticのmodel_dump_jsonを使用）
        with output_path.open("w", encoding="utf-8") as f:
            f.write(extraction_output.model_dump_json(indent=2))

        result_count = extraction_output.metadata.total_results
        logger.info(f"Successfully extracted {result_count} results for {project_name}")

        return CodeExtractionJobResult(
            status="success",
            project=project_name,
            output_path=str(output_path),
            result_count=result_count,
            error=None,
        )

    except Exception as e:
        logger.error(f"Error extracting code for {project_name}: {e}")
        return CodeExtractionJobResult(
            status="error",
            project=project_name,
            output_path=None,
            result_count=None,
            error=str(e),
        )
