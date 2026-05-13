"""データベースマイグレーション管理モジュール"""

import logging
from pathlib import Path
import sqlite3

logger = logging.getLogger(__name__)


class MigrationError(Exception):
    """マイグレーション実行時のエラー"""


class DatabaseMigrator:
    """データベースマイグレーションを管理するクラス"""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def _column_exists(self, conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
        cursor = conn.cursor()
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cursor.fetchall()]
        return column_name in columns

    def add_js_lines_count_column(self, *, dry_run: bool = False) -> bool:
        """projectsテーブルにjs_lines_countカラムを追加する"""
        if not self.database_path.exists():
            msg = f"Database file not found: {self.database_path}"
            raise MigrationError(msg)

        try:
            conn = sqlite3.connect(self.database_path)
            cursor = conn.cursor()

            if self._column_exists(conn, "projects", "js_lines_count"):
                logger.info("Column 'js_lines_count' already exists in 'projects' table")
                conn.close()
                return False

            if dry_run:
                logger.info("[DRY RUN] Would execute: ALTER TABLE projects ADD COLUMN js_lines_count INTEGER")
                conn.close()
                return True

            logger.info("Adding 'js_lines_count' column to 'projects' table...")
            cursor.execute("ALTER TABLE projects ADD COLUMN js_lines_count INTEGER")
            conn.commit()
            logger.info("Migration completed successfully")
            conn.close()
            return True

        except sqlite3.Error as e:
            msg = f"Failed to execute migration: {e}"
            logger.error(msg)
            raise MigrationError(msg) from e

    def run_all_migrations(self, *, dry_run: bool = False) -> dict[str, bool]:
        """全てのマイグレーションを実行する"""
        results: dict[str, bool] = {}

        migrations = [
            ("add_js_lines_count_column", self.add_js_lines_count_column),
        ]

        for name, migration_func in migrations:
            logger.info(f"Running migration: {name}")
            try:
                executed = migration_func(dry_run=dry_run)
                results[name] = executed
            except MigrationError:
                raise

        return results
