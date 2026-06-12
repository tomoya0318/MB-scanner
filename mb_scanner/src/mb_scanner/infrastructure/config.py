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

    # ログ設定
    log_level: str = "INFO"  # 例: MB_SCANNER_LOG_LEVEL=DEBUG
    log_file: Path | None = None  # 例: MB_SCANNER_LOG_FILE=/path/to/logs/app.log
    log_to_console: bool = True  # 例: MB_SCANNER_LOG_TO_CONSOLE=false

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


# シングルトンとしてインスタンスを作成
settings = Settings()
