"""Preprocessing ゲートウェイの契約定義"""

from collections.abc import Sequence
from typing import Protocol

from mb_scanner.domain.entities.preprocessing import (
    PreprocessingInput,
    PreprocessingIssueResult,
)


class PreprocessorPort(Protocol):
    """Selakovic 前処理エンジンの契約 (ADR-0024)

    **1 入力 → 1 IssueResult モデル**:
    1 issue から複数 candidate が出る場合は ``PreprocessingIssueResult.candidates: list``
    で内包する (旧モデルの flat 列ではない)。

    id は issue 単位で 1 対 1 (旧 ``<input.id>#<index>`` 形式の suffix 付与は廃止)。
    """

    def preprocess(self, input_: PreprocessingInput) -> PreprocessingIssueResult: ...

    def preprocess_batch(
        self,
        items: Sequence[PreprocessingInput],
    ) -> list[PreprocessingIssueResult]:
        """複数 issue を 1 回の subprocess 起動でまとめて前処理する。

        戻り値は **入力数 == 出力数** の対応列。各入力 ``items[i]`` に対応する結果が
        ``out[i]`` (= 入力順保持)。受理された各 issue の処理失敗 (parse-error など) は
        他 item の結果に波及してはならない (= 該当 IssueResult の ``issue_excluded`` を立てる)。
        """
        ...
