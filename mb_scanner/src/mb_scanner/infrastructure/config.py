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
    def effective_mb_analyzer_cli_path(self) -> Path:
        """mb-analyzer CLI バンドルのパスを返す（`mbs check-equivalence` 等が利用）"""
        return self.mb_analyzer_cli_path or Path.cwd() / "mb-analyzer" / "dist" / "cli.js"


# シングルトンとしてインスタンスを作成
settings = Settings()
