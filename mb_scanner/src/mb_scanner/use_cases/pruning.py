"""Pruning の Use Case 層

1 トリプル (setup, slow, fast) に対して ``PrunerPort`` を呼び出し、結果を
そのまま返す。equivalence と異なり ``observations`` を持たないため、verdict 再計算
ロジックは不要 (engine が verdict を直接決定する)。
"""

from collections.abc import Sequence

from mb_scanner.domain.entities.pruning import PruningInput, PruningResult
from mb_scanner.domain.ports.pruner import PrunerPort


class PruningUseCase:
    """Pruning Use Case

    Args:
        pruner: ``PrunerPort`` 実装（通常は ``NodeRunnerPrunerGateway``）
    """

    def __init__(self, pruner: PrunerPort) -> None:
        self._pruner = pruner

    def prune(self, input_: PruningInput) -> PruningResult:
        """1 トリプルを pruning して結果を返す。

        ``PruningResult`` の ``verdict`` は Node 側 engine が直接決定するため、
        Port から受け取った結果を素通しで返す。
        """
        return self._pruner.prune(input_)

    def prune_batch(self, items: Sequence[PruningInput]) -> list[PruningResult]:
        """複数トリプルをまとめて pruning して結果リストを返す。

        Port の ``prune_batch`` を 1 回呼ぶ。1 chunk 単位で呼ばれる前提で、CLI 層
        (``_run_batch``) が ``ThreadPoolExecutor`` で chunk を並列に投げる。
        """
        return self._pruner.prune_batch(items)
