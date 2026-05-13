"""データベースセッション管理モジュール"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from mb_scanner.infrastructure.config import settings
from mb_scanner.infrastructure.orm.base import Base

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session]:
    """データベースセッションを取得するジェネレータ"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """データベースを初期化し、全てのテーブルを作成する"""
    from mb_scanner.infrastructure.orm import tables  # noqa: F401, PLC0415  # pyright: ignore[reportUnusedImport]

    Base.metadata.create_all(bind=engine)


def drop_all_tables() -> None:
    """全てのテーブルを削除する（テスト用）"""
    Base.metadata.drop_all(bind=engine)
