"""Preprocessing ゲートウェイの契約定義"""

from collections.abc import Sequence
from typing import Protocol

from mb_scanner.domain.entities.preprocessing import PreprocessingInput, PreprocessingResult


class PreprocessorPort(Protocol):
    """Selakovic 前処理エンジンの契約

    **1 入力 → N 結果モデル**:
    同一 PR に独立した最適化が複数同居する場合に対応するため、``preprocess`` は
    ``list[PreprocessingResult]`` を返す。1 candidate なら 1 件、N candidates なら N 件。

    複数結果の id は ``<input.id>#<index>`` 形式で識別される (1 結果なら suffix なし)。
    """

    def preprocess(self, input_: PreprocessingInput) -> list[PreprocessingResult]: ...

    def preprocess_batch(self, items: Sequence[PreprocessingInput]) -> list[PreprocessingResult]:
        """複数 issue を 1 回の subprocess 起動でまとめて前処理する。

        戻り値は **入力順にフラット化された結果列**: 各入力から 1 つ以上の結果が出るので
        ``len(out) >= len(items)`` になりうる。各結果の id は元の入力 id (もしくは
        ``<input.id>#<index>`` suffix) が付いており、呼び出し側はそれで原入力との対応を
        取る。受理された各 issue の処理失敗 (parse-error など) は他 item の結果に
        波及してはならない。
        """
        ...
