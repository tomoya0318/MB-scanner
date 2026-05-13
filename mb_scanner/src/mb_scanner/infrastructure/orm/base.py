"""SQLAlchemyのベースクラスを定義するモジュール

全てのORMモデルはこのBaseクラスを継承します。
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """全てのSQLAlchemyモデルの基底クラス"""

    pass
