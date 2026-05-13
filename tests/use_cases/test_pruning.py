"""Pruning Use Case のテスト

UseCase は Port から受け取った結果を素通しで返すシンプルな構造。equivalence の
``derive_overall_verdict`` のような verdict 再計算は持たないため、検証範囲も
「Port に委譲する」「結果が素通しで返る」に絞る。
"""

from collections.abc import Sequence

from mb_scanner.domain.entities.pruning import (
    PruningInput,
    PruningResult,
    PruningVerdict,
)
from mb_scanner.use_cases.pruning import PruningUseCase


class _StubPruner:
    """Port スタブ。固定結果を返す"""

    def __init__(self, result: PruningResult) -> None:
        self._result = result
        self.last_input: PruningInput | None = None
        self.last_batch: list[PruningInput] | None = None

    def prune(self, input_: PruningInput) -> PruningResult:
        self.last_input = input_
        return self._result

    def prune_batch(self, items: Sequence[PruningInput]) -> list[PruningResult]:
        self.last_batch = list(items)
        return [self._result.model_copy(update={"id": item.id}) for item in items]


class TestPruningUseCase:
    def test_delegates_to_port(self) -> None:
        expected = PruningResult(verdict=PruningVerdict.PRUNED, pattern_code="2")
        stub = _StubPruner(expected)
        use_case = PruningUseCase(stub)

        input_ = PruningInput(slow="1+1", fast="2")
        result = use_case.prune(input_)

        assert stub.last_input == input_
        assert result.verdict is PruningVerdict.PRUNED
        assert result.pattern_code == "2"

    def test_passthrough_initial_mismatch(self) -> None:
        """UseCase は verdict を再計算せず Port 結果を素通しで返す"""
        stub_result = PruningResult(verdict=PruningVerdict.INITIAL_MISMATCH)
        use_case = PruningUseCase(_StubPruner(stub_result))
        result = use_case.prune(PruningInput(slow="1", fast="2"))
        assert result.verdict is PruningVerdict.INITIAL_MISMATCH

    def test_passthrough_error(self) -> None:
        err = PruningResult(
            verdict=PruningVerdict.ERROR,
            error_message="node runner crashed",
        )
        use_case = PruningUseCase(_StubPruner(err))
        result = use_case.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message == "node runner crashed"

    def test_preserves_effective_timeout_ms(self) -> None:
        result_with_echo = PruningResult(
            verdict=PruningVerdict.PRUNED,
            effective_timeout_ms=3000,
        )
        use_case = PruningUseCase(_StubPruner(result_with_echo))
        result = use_case.prune(PruningInput(slow="1", fast="1", timeout_ms=3000))
        assert result.effective_timeout_ms == 3000


class TestPruneBatch:
    def test_batch_delegates_to_prune_batch(self) -> None:
        expected = PruningResult(verdict=PruningVerdict.PRUNED)
        stub = _StubPruner(expected)
        use_case = PruningUseCase(stub)

        inputs = [
            PruningInput(id="a", slow="1", fast="1"),
            PruningInput(id="b", slow="2", fast="2"),
        ]
        results = use_case.prune_batch(inputs)

        assert stub.last_batch is not None
        assert [i.id for i in stub.last_batch] == ["a", "b"]
        assert [r.id for r in results] == ["a", "b"]
        assert all(r.verdict is PruningVerdict.PRUNED for r in results)

    def test_batch_passthrough_error(self) -> None:
        err = PruningResult(
            verdict=PruningVerdict.ERROR,
            error_message="subprocess crashed",
        )
        use_case = PruningUseCase(_StubPruner(err))
        results = use_case.prune_batch([PruningInput(id="a", slow="1", fast="1")])
        assert results[0].verdict is PruningVerdict.ERROR
        assert results[0].error_message == "subprocess crashed"
