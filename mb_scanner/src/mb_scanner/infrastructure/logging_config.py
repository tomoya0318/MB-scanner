"""ロギング設定モジュール

このモジュールでは、アプリケーション全体のログ設定を管理します。
"""

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import sys

from mb_scanner.infrastructure.config import settings


def setup_logging(*, log_level: str | None = None, log_file: Path | None = None) -> None:
    """ロギングを設定する

    Args:
        log_level: ログレベル（DEBUG, INFO, WARNING, ERROR, CRITICAL）
            指定されない場合は設定から取得
        log_file: ログファイルのパス
            指定されない場合は設定から取得（effective_log_file）
    """
    # ログレベルを決定
    level_str = log_level or settings.log_level
    level = getattr(logging, level_str.upper(), logging.INFO)

    # ログファイルを決定
    file_path = log_file or settings.effective_log_file

    # ルートロガーを取得
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # 既存のハンドラーをクリア（重複を防ぐ）
    root_logger.handlers.clear()

    # フォーマッターを作成
    formatter = logging.Formatter(
        fmt="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # コンソールハンドラーを追加
    if settings.log_to_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)

    # ファイルハンドラーを追加
    if file_path:
        # ログディレクトリを作成
        file_path.parent.mkdir(parents=True, exist_ok=True)

        # RotatingFileHandlerを使用してログローテーション
        file_handler = RotatingFileHandler(
            file_path,
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=5,  # 最大5つのバックアップファイル
            encoding="utf-8",
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)

    # 初期ログメッセージ
    root_logger.info("Logging initialized: level=%s, file=%s", level_str.upper(), file_path)


def get_logger(name: str) -> logging.Logger:
    """指定された名前のロガーを取得する

    Args:
        name: ロガー名（通常は __name__ を使用）

    Returns:
        logging.Logger: ロガーインスタンス
    """
    return logging.getLogger(name)
