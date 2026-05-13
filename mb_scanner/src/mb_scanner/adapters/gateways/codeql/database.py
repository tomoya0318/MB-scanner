"""CodeQLデータベース管理モジュール

このモジュールでは、CodeQLデータベースの管理機能を提供します。
"""

import logging
from pathlib import Path
import shutil

from joblib import Parallel, delayed

from mb_scanner.adapters.gateways.codeql.command import CodeQLCLI

logger = logging.getLogger(__name__)


class CodeQLDatabaseManager:
    """CodeQLデータベースの管理クラス

    データベースのパス生成、存在チェック、作成などの機能を提供します。
    """

    def __init__(self, cli: CodeQLCLI, base_dir: Path) -> None:
        """CodeQLDatabaseManagerを初期化する

        Args:
            cli: CodeQLCLIインスタンス
            base_dir: DBの保存先ベースディレクトリ
        """
        self.cli = cli
        self.base_dir = base_dir

    def get_database_path(self, project_full_name: str) -> Path:
        """プロジェクト名からDBパスを生成する

        Args:
            project_full_name: プロジェクト名（owner/repo形式）

        Returns:
            Path: DBの保存先パス

        Examples:
            >>> manager = CodeQLDatabaseManager(cli, Path("/data/codeql-dbs"))
            >>> manager.get_database_path("facebook/react")
            Path('/data/codeql-dbs/facebook-react')
        """
        # "facebook/react" -> "facebook-react"
        safe_name = project_full_name.replace("/", "-")
        return self.base_dir / safe_name

    def database_exists(self, project_full_name: str) -> bool:
        """DBが既に存在するかチェックする

        Args:
            project_full_name: プロジェクト名（owner/repo形式）

        Returns:
            bool: DBが存在する場合True、存在しない場合False
        """
        db_path = self.get_database_path(project_full_name)
        exists = db_path.exists()
        logger.debug("Database exists check for %s: %s", project_full_name, exists)
        return exists

    def create_database(
        self,
        project_full_name: str,
        source_root: Path,
        language: str,
        *,
        threads: int | None = None,
        ram: int | None = None,
        force: bool = False,
    ) -> Path:
        """プロジェクトのCodeQL DBを作成する

        Args:
            project_full_name: プロジェクト名（owner/repo形式）
            source_root: ソースコードのルートディレクトリ
            language: 解析言語
            threads: 使用するスレッド数
            ram: 使用するRAM（MB）
            force: 既存DBを削除して再作成するか

        Returns:
            Path: 作成されたDBのパス

        Raises:
            FileExistsError: DBが既に存在し、force=Falseの場合
            FileNotFoundError: source_rootが存在しない場合
            subprocess.CalledProcessError: DB作成に失敗した場合
        """
        db_path = self.get_database_path(project_full_name)

        # 既存DBのチェック
        if db_path.exists():
            if not force:
                error_msg = f"Database already exists: {db_path}. Use force=True to overwrite."
                logger.error(error_msg)
                raise FileExistsError(error_msg)

            logger.warning("Removing existing database: %s", db_path)
            shutil.rmtree(db_path)

        # DB作成
        self.cli.create_database(
            database_path=db_path,
            source_root=source_root,
            language=language,
            threads=threads,
            ram=ram,
        )

        logger.info("Created CodeQL database for %s at %s", project_full_name, db_path)
        return db_path

    def analyze_database(
        self,
        project_full_name: str,
        output_dir: Path | None = None,
        *,
        query_files: list[Path] | None = None,
        format: str = "sarifv2.1.0",
        threads: int | None = None,
        ram: int | None = None,
    ) -> Path:
        """プロジェクトのCodeQL DBを分析する

        Args:
            project_full_name: プロジェクト名（owner/repo形式）
            output_dir: 結果の出力先ディレクトリ（未指定の場合は outputs/queries/{project_name}/）
            query_files: クエリファイル(.ql)のリスト
            format: 出力形式（デフォルト: sarifv2.1.0）
            threads: 使用するスレッド数
            ram: 使用するRAM（MB）

        Returns:
            Path: 生成された結果ファイルのパス

        Raises:
            FileNotFoundError: DBが存在しない場合
            subprocess.CalledProcessError: 分析に失敗した場合

        Examples:
            >>> manager = CodeQLDatabaseManager(cli, Path("data/codeql-dbs"))
            >>> result_path = manager.analyze_database(
            ...     "facebook/react",
            ...     query_files=[Path("codeql/queries/id_10.ql")]
            ... )
        """
        db_path = self.get_database_path(project_full_name)

        # 出力先ディレクトリの決定
        if output_dir is None:
            safe_name = project_full_name.replace("/", "-")
            output_dir = Path("outputs/queries") / safe_name

        output_path = output_dir / "results.sarif"

        # DB分析を実行
        self.cli.analyze_database(
            database_path=db_path,
            output_path=output_path,
            query_files=query_files,
            format=format,
            threads=threads,
            ram=ram,
        )

        logger.info("Analyzed CodeQL database for %s at %s", project_full_name, output_path)
        return output_path

    def analyze_databases_parallel(
        self,
        project_full_names: list[str],
        base_output_dir: Path | None = None,
        *,
        query_files: list[Path] | None = None,
        format: str = "sarifv2.1.0",
        n_jobs: int = -1,
        threads_per_job: int | None = None,
        ram_per_job: int | None = None,
    ) -> dict[str, Path]:
        """複数のプロジェクトのCodeQL DBを並列分析する

        Args:
            project_full_names: プロジェクト名のリスト（owner/repo形式）
            base_output_dir: 結果の出力先ベースディレクトリ（未指定の場合は outputs/queries/）
            query_files: クエリファイル(.ql)のリスト
            format: 出力形式（デフォルト: sarifv2.1.0）
            n_jobs: 並列ジョブ数（-1で全CPU使用）
            threads_per_job: 各ジョブの使用スレッド数
            ram_per_job: 各ジョブの使用RAM（MB）

        Returns:
            dict[str, Path]: プロジェクト名と結果ファイルパスのマッピング

        Examples:
            >>> manager = CodeQLDatabaseManager(cli, Path("data/codeql-dbs"))
            >>> results = manager.analyze_databases_parallel(
            ...     ["facebook/react", "microsoft/vscode"],
            ...     query_files=[Path("codeql/queries/id_10.ql")]
            ... )
        """
        if base_output_dir is None:
            base_output_dir = Path("outputs/queries")

        # 並列実行
        result_paths: list[Path] = Parallel(n_jobs=n_jobs)(
            delayed(self.analyze_database)(
                project_name,
                output_dir=base_output_dir / project_name.replace("/", "-"),
                query_files=query_files,
                format=format,
                threads=threads_per_job,
                ram=ram_per_job,
            )
            for project_name in project_full_names
        )

        # 辞書形式で返す
        return dict(zip(project_full_names, result_paths, strict=True))
