"""Selakovic 前処理の Use Case 層

1 issue または複数 issue に対して ``PreprocessorPort`` を呼び出し、結果を
そのまま返す。ADR-0024 で 1 入力 → 1 IssueResult モデル (内部に candidates: list)。
"""

from collections.abc import Sequence

from mb_scanner.domain.entities.preprocessing import (
    PreprocessingInput,
    PreprocessingIssueResult,
)
from mb_scanner.domain.ports.preprocessor import PreprocessorPort


class SelakovicPreprocessingUseCase:
    """Selakovic 前処理 Use Case

    Args:
        preprocessor: ``PreprocessorPort`` 実装 (通常は ``NodeRunnerPreprocessorGateway``)
    """

    def __init__(self, preprocessor: PreprocessorPort) -> None:
        self._preprocessor = preprocessor

    def preprocess(self, input_: PreprocessingInput) -> PreprocessingIssueResult:
        """1 issue を前処理して 1 つの IssueResult を返す (1 入力 → 1 IssueResult)。"""
        return self._preprocessor.preprocess(input_)

    def preprocess_batch(
        self,
        items: Sequence[PreprocessingInput],
    ) -> list[PreprocessingIssueResult]:
        """複数 issue をまとめて前処理する (入力順保持、入力数 == 出力数)。"""
        return self._preprocessor.preprocess_batch(items)
