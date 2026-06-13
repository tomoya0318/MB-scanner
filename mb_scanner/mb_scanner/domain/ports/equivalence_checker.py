"""等価性検証ゲートウェイの契約定義"""

from collections.abc import Sequence
from typing import Protocol

from mb_scanner.domain.entities.equivalence import EquivalenceCheckResult, EquivalenceInput


class EquivalenceCheckerPort(Protocol):
    """等価性検証器の契約

    実装はサブプロセス経由で Node ランナーを呼び出す前提。
    """

    def check(self, input_: EquivalenceInput) -> EquivalenceCheckResult: ...

    def check_batch(self, items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
        """複数トリプルを 1 回の subprocess 起動でまとめて検証する。

        結果の順序は ``items`` と一致する（``id`` が埋まっていれば実装はそれをキーに
        突き合わせる責務を持つ）。1 トリプルの失敗が他に波及してはならない。
        """
        ...
