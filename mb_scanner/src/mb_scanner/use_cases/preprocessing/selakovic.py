"""Selakovic 前処理の Use Case 層

1 issue または複数 issue に対して ``PreprocessorPort`` を呼び出し、結果を
そのまま返す。pruning と同じく Port から受け取った結果を素通しする。
"""

from collections.abc import Sequence

from mb_scanner.domain.entities.preprocessing import PreprocessingInput, PreprocessingResult
from mb_scanner.domain.ports.preprocessor import PreprocessorPort


class SelakovicPreprocessingUseCase:
    """Selakovic 前処理 Use Case

    Args:
        preprocessor: ``PreprocessorPort`` 実装 (通常は ``NodeRunnerPreprocessorGateway``)
    """

    def __init__(self, preprocessor: PreprocessorPort) -> None:
        self._preprocessor = preprocessor

    def preprocess(self, input_: PreprocessingInput) -> list[PreprocessingResult]:
        """1 issue を前処理して結果配列を返す (1 入力 → N 結果モデル)。

        Port から受け取った結果を素通し。
        """
        return self._preprocessor.preprocess(input_)

    def preprocess_batch(self, items: Sequence[PreprocessingInput]) -> list[PreprocessingResult]:
        """複数 issue をまとめて前処理する。

        Port の ``preprocess_batch`` を 1 回呼ぶ。CLI 層が ``ThreadPoolExecutor`` で
        chunk を並列に投げる前提。
        """
        return self._preprocessor.preprocess_batch(items)
