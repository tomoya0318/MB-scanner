"""JavaScriptファイルの行数をカウントするモジュール"""

import logging
from pathlib import Path
from typing import ClassVar

logger = logging.getLogger(__name__)


class JSLinesCounter:
    """JavaScriptファイルの行数をカウントするクラス

    .js, .jsx, .mjs, .cjsファイルを対象に、
    空行やコメント行を含む総行数をカウントします。
    """

    # カウント対象のJavaScript拡張子
    JS_EXTENSIONS: ClassVar[set[str]] = {".js", ".jsx", ".mjs", ".cjs"}

    def count_lines_in_file(self, file_path: Path) -> int:
        """単一のJSファイルの行数をカウントする

        Args:
            file_path: カウント対象のファイルパス

        Returns:
            int: ファイルの行数（空行・コメント行を含む）
                 ファイルが存在しない場合や読み取りエラーの場合は0を返す
        """
        if not file_path.exists():
            logger.debug(f"File not found: {file_path}")
            return 0

        if not file_path.is_file():
            logger.debug(f"Not a file: {file_path}")
            return 0

        try:
            # ファイルを読み込んで行数をカウント
            with file_path.open("r", encoding="utf-8") as f:
                lines = f.readlines()
                return len(lines)
        except UnicodeDecodeError:
            # バイナリファイルの場合はスキップ
            logger.debug(f"Binary file skipped: {file_path}")
            return 0
        except OSError as e:
            # 読み取りエラー（権限不足など）
            logger.warning(f"Failed to read file {file_path}: {e}")
            return 0

    def count_lines_in_directory(self, directory: Path) -> int:
        """ディレクトリ内の全JSファイルの総行数をカウントする

        ディレクトリを再帰的に走査し、.js, .jsx, .mjs, .cjsファイルの
        総行数を集計します。

        Args:
            directory: カウント対象のディレクトリパス

        Returns:
            int: ディレクトリ内の全JSファイルの総行数
                 ディレクトリが存在しない場合は0を返す
        """
        if not directory.exists():
            logger.debug(f"Directory not found: {directory}")
            return 0

        if not directory.is_dir():
            logger.debug(f"Not a directory: {directory}")
            return 0

        total_lines = 0

        try:
            # ディレクトリを再帰的に走査
            for file_path in directory.rglob("*"):
                # JSファイルかチェック
                if file_path.suffix in self.JS_EXTENSIONS and file_path.is_file():
                    lines = self.count_lines_in_file(file_path)
                    total_lines += lines
                    logger.debug(f"Counted {lines} lines in {file_path}")

        except OSError as e:
            logger.warning(f"Error while traversing directory {directory}: {e}")

        return total_lines
