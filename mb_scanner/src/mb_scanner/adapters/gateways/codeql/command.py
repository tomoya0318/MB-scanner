"""CodeQL CLIのラッパーモジュール

このモジュールでは、CodeQL CLIコマンドをPythonから実行するための機能を提供します。
"""

import logging
from pathlib import Path
import subprocess

logger = logging.getLogger(__name__)


class CodeQLCLI:
    """CodeQL CLIのラッパークラス

    subprocessを使用してCodeQL CLIコマンドを実行します。
    """

    def __init__(self, cli_path: str = "codeql") -> None:
        """CodeQLCLIを初期化する

        Args:
            cli_path: CodeQL CLIの実行パス（デフォルト: "codeql"）
        """
        self.cli_path = cli_path

    def create_database(
        self,
        database_path: Path,
        source_root: Path,
        language: str,
        *,
        threads: int | None = None,
        ram: int | None = None,
        timeout: int = 3600,
    ) -> None:
        """CodeQLデータベースを作成する

        Args:
            database_path: 作成するDBのパス（存在してはいけない）
            source_root: ソースコードのルートディレクトリ
            language: 解析言語（javascript, python, など）
            threads: 使用するスレッド数（指定しない場合は自動）
            ram: 使用するRAM（MB、指定しない場合は自動）
            timeout: タイムアウト時間（秒、デフォルト: 3600秒）

        Raises:
            FileExistsError: database_pathが既に存在する場合
            FileNotFoundError: source_rootが存在しない場合
            subprocess.CalledProcessError: DB作成に失敗した場合
            subprocess.TimeoutExpired: タイムアウトした場合

        Examples:
            >>> cli = CodeQLCLI()
            >>> cli.create_database(
            ...     Path("/data/codeql-dbs/my-db"),
            ...     Path("/tmp/source"),
            ...     "javascript"
            ... )
        """
        if database_path.exists():
            error_msg = f"Database path already exists: {database_path}"
            logger.error(error_msg)
            raise FileExistsError(error_msg)

        if not source_root.exists():
            error_msg = f"Source root does not exist: {source_root}"
            logger.error(error_msg)
            raise FileNotFoundError(error_msg)

        # 親ディレクトリが存在しない場合は作成
        database_path.parent.mkdir(parents=True, exist_ok=True)

        # codeql database createコマンドを構築
        cmd = [
            self.cli_path,
            "database",
            "create",
            str(database_path),
            f"--language={language}",
            f"--source-root={source_root}",
        ]

        # オプションパラメータを追加
        if threads is not None:
            cmd.append(f"--threads={threads}")
        if ram is not None:
            cmd.append(f"--ram={ram}")

        logger.info(
            "Creating CodeQL database: %s (language=%s, source=%s)",
            database_path,
            language,
            source_root,
        )
        logger.debug("CodeQL command: %s", " ".join(cmd))

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout,
            )
            logger.info("Successfully created CodeQL database: %s", database_path)
            logger.debug("CodeQL output: %s", result.stdout)

        except subprocess.CalledProcessError as e:
            error_msg = f"Failed to create CodeQL database: {e.stderr}"
            logger.error(error_msg)
            raise

        except subprocess.TimeoutExpired:
            error_msg = f"CodeQL database creation timeout after {timeout}s"
            logger.error(error_msg)
            raise

    def check_version(self) -> str:
        """CodeQL CLIのバージョンを取得する

        Returns:
            str: CodeQL CLIのバージョン文字列

        Raises:
            subprocess.CalledProcessError: コマンド実行に失敗した場合
            FileNotFoundError: CodeQL CLIが見つからない場合
        """
        cmd = [self.cli_path, "version"]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
            version = result.stdout.strip()
            logger.debug("CodeQL version: %s", version)
            return version

        except FileNotFoundError as e:
            error_msg = f"CodeQL CLI not found at: {self.cli_path}"
            logger.error(error_msg)
            raise FileNotFoundError(error_msg) from e

        except subprocess.CalledProcessError as e:
            error_msg = f"Failed to get CodeQL version: {e.stderr}"
            logger.error(error_msg)
            raise

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
        timeout: int = 3600,
    ) -> None:
        """CodeQLデータベースを分析する

        Args:
            database_path: 分析するDBのパス
            output_path: 結果の出力先パス
            query_files: クエリファイル(.ql)のリスト（指定しない場合はデフォルトクエリを使用）
            format: 出力形式（デフォルト: sarifv2.1.0）
            threads: 使用するスレッド数（指定しない場合は自動）
            ram: 使用するRAM（MB、指定しない場合は自動）
            sarif_category: SARIF出力のカテゴリ（複数言語分析時に使用）
            sarif_add_snippets: コードスニペットを含めるか（デフォルト: True）
            timeout: タイムアウト時間（秒、デフォルト: 3600秒）

        Raises:
            FileNotFoundError: database_pathまたはquery_filesが存在しない場合
            subprocess.CalledProcessError: 分析に失敗した場合
            subprocess.TimeoutExpired: タイムアウトした場合

        Examples:
            >>> cli = CodeQLCLI()
            >>> cli.analyze_database(
            ...     Path("/data/codeql-dbs/my-db"),
            ...     Path("outputs/results.sarif"),
            ...     query_files=[Path("codeql/queries/id_10.ql")]
            ... )
        """
        if not database_path.exists():
            error_msg = f"Database does not exist: {database_path}"
            logger.error(error_msg)
            raise FileNotFoundError(error_msg)

        # クエリファイルの存在確認
        if query_files:
            for query_file in query_files:
                if not query_file.exists():
                    error_msg = f"Query file does not exist: {query_file}"
                    logger.error(error_msg)
                    raise FileNotFoundError(error_msg)

        # 出力先ディレクトリを作成
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # codeql database analyzeコマンドを構築
        cmd = [
            self.cli_path,
            "database",
            "analyze",
            str(database_path),
            "--rerun",
            f"--format={format}",
            f"--output={output_path}",
        ]

        # クエリファイルを追加
        if query_files:
            cmd.extend(str(qf) for qf in query_files)

        # オプションパラメータを追加
        if threads is not None:
            cmd.append(f"--threads={threads}")
        if ram is not None:
            cmd.append(f"--ram={ram}")
        if sarif_category is not None:
            cmd.append(f"--sarif-category={sarif_category}")
        if sarif_add_snippets:
            cmd.append("--sarif-add-snippets")

        logger.info(
            "Analyzing CodeQL database: %s (output=%s)",
            database_path,
            output_path,
        )
        logger.debug("CodeQL command: %s", " ".join(cmd))

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout,
            )
            logger.info("Successfully analyzed CodeQL database: %s", database_path)
            logger.debug("CodeQL output: %s", result.stdout)

        except subprocess.CalledProcessError as e:
            error_msg = f"Failed to analyze CodeQL database: {e.stderr}"
            logger.error(error_msg)
            raise

        except subprocess.TimeoutExpired:
            error_msg = f"CodeQL database analysis timeout after {timeout}s"
            logger.error(error_msg)
            raise
