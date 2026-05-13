"""プロジェクトで使用する環境設定モジュール

このモジュールは、プロジェクト全体で使用する設定値や定数を定義します。
主に、データセットのパスやディレクトリ構成を管理するために使用されます。
"""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """アプリケーション全体の設定を管理するクラス

    環境変数や.envファイルから自動で値を読み込む
    """

    # .envファイルを読み込む設定と、環境変数の接頭辞（プレフィックス）を指定
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MB_SCANNER_",
        extra="ignore",  # 未定義のフィールドを無視（Docker用の環境変数などを許容）
    )

    # データベース関連
    data_dir: Path | None = None  # 例: MB_SCANNER_DATA_DIR=/path/to/data
    db_file: Path | None = None  # 例: MB_SCANNER_DB_FILE=/path/to/data/app.db

    # GitHub API
    github_token: str | None = Field(default=None, validation_alias="GITHUB_TOKEN")  # GitHub API Token
    github_search_default_language: str = Field(
        default="JavaScript",
        description="GitHub検索で使用するデフォルト言語",
    )
    github_search_default_min_stars: int = Field(
        default=100,
        ge=0,
        description="GitHub検索で使用するデフォルトの最小スター数",
    )
    github_search_default_max_days_since_commit: int = Field(
        default=365,
        ge=1,
        description="GitHub検索で使用するデフォルトの最終コミット経過日数",
    )

    # ログ設定
    log_level: str = "INFO"  # 例: MB_SCANNER_LOG_LEVEL=DEBUG
    log_file: Path | None = None  # 例: MB_SCANNER_LOG_FILE=/path/to/logs/app.log
    log_to_console: bool = True  # 例: MB_SCANNER_LOG_TO_CONSOLE=false

    # CodeQL関連設定
    codeql_cli_path: str = Field(
        default="codeql",
        description="CodeQL CLIの実行パス（PATHに通っている場合は'codeql'）",
    )
    codeql_db_base_dir: Path | None = Field(
        default=None,
        description="CodeQLデータベース保存先のベースディレクトリ",
    )
    codeql_clone_base_dir: Path | None = Field(
        default=None,
        description="リポジトリクローン先のベースディレクトリ",
    )
    codeql_default_language: str = Field(
        default="javascript",
        description="CodeQL解析のデフォルト言語",
    )
    codeql_output_base_dir: Path | None = Field(
        default=None,
        description="CodeQLクエリ実行結果の出力先ベースディレクトリ",
    )
    codeql_default_output_format: str = Field(
        default="sarifv2.1.0",
        description="CodeQLクエリ実行結果のデフォルト出力フォーマット",
    )

    # 可視化関連設定
    total_projects_count: int = Field(
        default=1000,
        ge=1,
        description="分析対象の総プロジェクト数（箱ひげ図などで母数を揃えるために使用）",
    )

    # ベンチマーク関連設定
    benchmark_dir: Path | None = Field(
        default=None,
        description="ベンチマークデータの保存先ディレクトリ",
    )
    benchmark_runner_js_path: Path | None = Field(
        default=None,
        description="ベンチマークランナーJSファイルのパス（DEPRECATED: 旧 mb-analyzer-legacy 用）",
    )

    # 新 mb-analyzer CLI 関連設定
    mb_analyzer_cli_path: Path | None = Field(
        default=None,
        description=(
            "mb-analyzer（新 TypeScript 実装）の CLI バンドル dist/cli.js のパス。"
            "未指定なら cwd 基準のデフォルト位置を利用する。"
        ),
    )
    mb_analyzer_node_bin: str = Field(
        default="node",
        description="mb-analyzer を起動する Node.js 実行ファイル。PATH 上なら 'node' のままで良い",
    )

    @property
    def effective_data_dir(self) -> Path:
        """データディレクトリの有効なパスを返す"""
        # data_dirが指定されていなければ、現在の作業ディレクトリに 'data' を作成
        path = self.data_dir or Path.cwd() / "data"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def effective_db_file(self) -> Path:
        """データベースファイルの有効なパスを返す"""
        # db_fileが指定されていればそれを使い、なければデフォルトパスを生成
        return self.db_file or self.effective_data_dir / "mb_scanner.db"

    @property
    def effective_log_file(self) -> Path:
        """ログファイルの有効なパスを返す"""
        # log_fileが指定されていればそれを使い、なければデフォルトパスを生成
        return self.log_file or self.effective_data_dir / "mb_scanner.log"

    @property
    def database_url(self) -> str:
        """SQLAlchemy用のデータベースURLを返す"""
        return f"sqlite:///{self.effective_db_file.resolve()}"

    @property
    def effective_codeql_db_dir(self) -> Path:
        """CodeQL DBの保存先ディレクトリを返す（data/codeql-dbs）"""
        path = self.codeql_db_base_dir or self.effective_data_dir / "codeql-dbs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def effective_codeql_clone_dir(self) -> Path:
        """リポジトリクローン先ディレクトリを返す（data/repositories）"""
        path = self.codeql_clone_base_dir or self.effective_data_dir / "repositories"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def effective_codeql_output_dir(self) -> Path:
        """CodeQLクエリ実行結果の出力先ディレクトリを返す（outputs/queries）"""
        path = self.codeql_output_base_dir or Path.cwd() / "outputs" / "queries"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def effective_benchmark_dir(self) -> Path:
        """ベンチマークディレクトリを返す（data/benchmarks）"""
        path = self.benchmark_dir or self.effective_data_dir / "benchmarks"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def effective_mb_analyzer_cli_path(self) -> Path:
        """mb-analyzer CLI バンドルのパスを返す（`mbs check-equivalence` 等が利用）"""
        return self.mb_analyzer_cli_path or Path.cwd() / "mb-analyzer" / "dist" / "cli.js"

    @property
    def effective_benchmark_runner_js_path(self) -> Path:
        """ベンチマークランナーJSファイルのパスを返す

        DEPRECATED: 旧 equivalence-check コマンド（`mbs benchmark equivalence-check`）用。
        新 `mbs check-equivalence` は `mb-analyzer/dist/cli.js` を使用する。
        """
        return (
            self.benchmark_runner_js_path
            or Path.cwd() / "mb-analyzer-legacy" / "apps" / "equivalence-runner" / "dist" / "index.js"
        )

    def get_codeql_output_path(self, project_name: str, query_file: Path) -> Path:
        """プロジェクト名とクエリファイルからCodeQLクエリ実行結果の出力パスを生成する

        Args:
            project_name: プロジェクト名（例: "facebook/react"）
            query_file: クエリファイルのパス（例: "codeql/queries/id_10.ql"）

        Returns:
            Path: 出力パス（例: "outputs/queries/id_10/facebook-react.sarif"）
        """
        # プロジェクト名のスラッシュをハイフンに置き換え
        safe_name = project_name.replace("/", "-")
        # クエリファイル名（拡張子なし）をディレクトリ名として使用
        query_name = query_file.stem  # id_10.ql -> id_10
        return self.effective_codeql_output_dir / query_name / f"{safe_name}.sarif"


# シングルトンとしてインスタンスを作成
settings = Settings()
