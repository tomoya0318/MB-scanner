"""Pruning ゲートウェイの契約定義"""

from collections.abc import Sequence
from typing import Protocol

from mb_scanner.domain.entities.pruning import PruningInput, PruningResult


class PrunerPort(Protocol):
    """Pruning エンジンの契約

    実装はサブプロセス経由で Node ランナーを呼び出す前提。
    """

    def prune(self, input_: PruningInput) -> PruningResult: ...

    def prune_batch(self, items: Sequence[PruningInput]) -> list[PruningResult]:
        """複数トリプルを 1 回の subprocess 起動でまとめて pruning する。

        結果の順序は ``items`` と一致する（``id`` が埋まっていれば実装はそれをキーに
        突き合わせる責務を持つ）。受理された各トリプルの処理失敗は他 item の結果に
        波及してはならない。

        ただし、実装が内部で利用する予約プレフィックスに ``PruningInput.id`` が衝突
        するなど、バッチ全体の前提を満たさない入力は事前条件違反として扱われ、
        ``ValueError`` を送出してバッチ全体を拒否してよい。
        """
        ...
