"""クリーンアップ処理を提供するモジュール

このモジュールでは、一時ディレクトリの削除など、クリーンアップ処理を提供します。
"""

import logging
from pathlib import Path
import shutil

logger = logging.getLogger(__name__)


def cleanup_directory(path: Path, *, ignore_errors: bool = True) -> None:
    """ディレクトリを安全に削除する

    指定されたディレクトリとその中身を再帰的に削除します。
    エラーが発生した場合、ignore_errorsがTrueならログに記録し、Falseなら例外を送出します。

    Args:
        path: 削除するディレクトリのパス
        ignore_errors: エラーを無視するか（デフォルト: True）

    Raises:
        OSError: ディレクトリの削除に失敗した場合（ignore_errors=Falseの場合のみ）

    Examples:
        >>> cleanup_directory(Path("/tmp/test-dir"))
        >>> cleanup_directory(Path("/tmp/test-dir"), ignore_errors=False)
    """
    if not path.exists():
        logger.debug("Directory does not exist, skipping cleanup: %s", path)
        return

    if not path.is_dir():
        logger.warning("Path is not a directory, skipping cleanup: %s", path)
        return

    try:
        logger.info("Cleaning up directory: %s", path)
        shutil.rmtree(path)
        logger.info("Successfully cleaned up directory: %s", path)
    except Exception as e:
        error_msg = f"Failed to cleanup directory {path}: {e}"
        if ignore_errors:
            logger.warning(error_msg)
        else:
            logger.error(error_msg)
            raise
