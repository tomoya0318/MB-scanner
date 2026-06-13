"""Node ランナー共通の基盤

各段 (equivalence / pruning / preprocessing) の Node ランナーが共有する
バッチ API 入出力の基底モデルを集約する。段ごとの ``models.py`` が継承する。
"""

from pydantic import BaseModel


class BatchItemModel(BaseModel):
    """バッチ API の 1 要素を表す入出力モデルの共通基底

    ``id`` はバッチ API で Python ↔ Node 間の順序暗黙依存を避けるための optional マーカー。
    単発 API では ``None`` のままで後方互換。サブクラスが ``model_config``
    (``extra="forbid"`` / ``"ignore"``) と固有フィールドを定義する。
    """

    id: str | None = None
