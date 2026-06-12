"""等価性検証 Use Case のテスト"""

from collections.abc import Sequence

import pytest

from mb_scanner.domain.entities.equivalence import (
    EquivalenceCheckResult,
    EquivalenceInput,
    Oracle,
    OracleObservation,
    OracleVerdict,
    Verdict,
)
from mb_scanner.use_cases.equivalence_verification import (
    EquivalenceVerificationUseCase,
    derive_overall_verdict,
    derive_verdict_reason,
)


def obs(verdict: OracleVerdict, oracle: Oracle = Oracle.RETURN_VALUE) -> OracleObservation:
    return OracleObservation(oracle=oracle, verdict=verdict)


_NA = OracleVerdict.NOT_APPLICABLE
_EQ = OracleVerdict.EQUAL
_NE = OracleVerdict.NOT_EQUAL
_ERR = OracleVerdict.ERROR


class TestDeriveOverallVerdict:
    @pytest.mark.parametrize(
        ("observations", "expected"),
        [
            # not_equal 優先
            ([obs(_EQ), obs(_NE, Oracle.INTERACTION_TRACE), obs(_NA, Oracle.EXCEPTION)], Verdict.NOT_EQUAL),
            # error は not_equal の次
            ([obs(_EQ), obs(_ERR, Oracle.ARGUMENT_MUTATION), obs(_NA, Oracle.EXCEPTION)], Verdict.ERROR),
            # 全 not_applicable は inconclusive (was error)
            (
                [
                    obs(_NA),
                    obs(_NA, Oracle.ARGUMENT_MUTATION),
                    obs(_NA, Oracle.EXCEPTION),
                    obs(_NA, Oracle.EXTERNAL_OBSERVATION),
                ],
                Verdict.INCONCLUSIVE,
            ),
            # 空 observation は inconclusive (was error)
            ([], Verdict.INCONCLUSIVE),
            # return_value=equal (positive evidence) → equal
            ([obs(_EQ), obs(_NA, Oracle.ARGUMENT_MUTATION)], Verdict.EQUAL),
            # interaction_trace=equal (positive evidence) → equal
            ([obs(_NA), obs(_EQ, Oracle.INTERACTION_TRACE), obs(_NA, Oracle.EXCEPTION)], Verdict.EQUAL),
            # argument_mutation=equal (positive evidence) → equal
            ([obs(_EQ, Oracle.ARGUMENT_MUTATION), obs(_EQ, Oracle.EXCEPTION)], Verdict.EQUAL),
            # exception=equal だけ (両側同じくクラッシュ) → inconclusive
            (
                [
                    obs(_NA),
                    obs(_NA, Oracle.ARGUMENT_MUTATION),
                    obs(_EQ, Oracle.EXCEPTION),
                    obs(_NA, Oracle.EXTERNAL_OBSERVATION),
                ],
                Verdict.INCONCLUSIVE,
            ),
            # dom_mutation=equal は positive evidence (C-2 で dom_changed を見て N/A 判定する前提) → equal
            ([obs(_NA), obs(_NA, Oracle.INTERACTION_TRACE), obs(_EQ, Oracle.DOM_MUTATION)], Verdict.EQUAL),
            # external_observation=equal だけ (positive evidence 無し) → inconclusive
            (
                [obs(_NA), obs(_NA, Oracle.INTERACTION_TRACE), obs(_EQ, Oracle.EXTERNAL_OBSERVATION)],
                Verdict.INCONCLUSIVE,
            ),
            # exception=equal + dom_mutation=equal だけ → inconclusive (bootstrap で DOM 触ってから両側同じく落ちた = 弱い equal、ADR-0018 + C-2 保守化)
            (
                [
                    obs(_NA),
                    obs(_NA, Oracle.ARGUMENT_MUTATION),
                    obs(_EQ, Oracle.EXCEPTION),
                    obs(_NA, Oracle.INTERACTION_TRACE),
                    obs(_EQ, Oracle.DOM_MUTATION),
                ],
                Verdict.INCONCLUSIVE,
            ),
            # exception=equal + dom_mutation=equal + interaction_trace=equal → equal (workload が trace を残しているので exercise されている)
            (
                [
                    obs(_NA),
                    obs(_NA, Oracle.ARGUMENT_MUTATION),
                    obs(_EQ, Oracle.EXCEPTION),
                    obs(_EQ, Oracle.INTERACTION_TRACE),
                    obs(_EQ, Oracle.DOM_MUTATION),
                ],
                Verdict.EQUAL,
            ),
        ],
    )
    def test_precedence(self, observations: list[OracleObservation], expected: Verdict) -> None:
        assert derive_overall_verdict(observations) == expected


class TestDeriveVerdictReason:
    def test_none_for_non_inconclusive(self) -> None:
        assert derive_verdict_reason([obs(_EQ)], Verdict.EQUAL) is None
        assert derive_verdict_reason([obs(_NE)], Verdict.NOT_EQUAL) is None
        assert derive_verdict_reason([], Verdict.ERROR) is None

    def test_no_observable_channel(self) -> None:
        assert derive_verdict_reason([], Verdict.INCONCLUSIVE) == "no-observable-channel"
        assert (
            derive_verdict_reason([obs(_NA), obs(_NA, Oracle.EXCEPTION)], Verdict.INCONCLUSIVE)
            == "no-observable-channel"
        )

    def test_both_sides_threw(self) -> None:
        assert (
            derive_verdict_reason(
                [obs(_NA), obs(_EQ, Oracle.EXCEPTION), obs(_NA, Oracle.DOM_MUTATION)],
                Verdict.INCONCLUSIVE,
            )
            == "both-sides-threw"
        )

    def test_no_positive_evidence(self) -> None:
        # 例外も無く positive evidence も無い (dom_mutation だけが equal)
        assert (
            derive_verdict_reason([obs(_NA), obs(_EQ, Oracle.DOM_MUTATION)], Verdict.INCONCLUSIVE)
            == "no-positive-evidence"
        )

    def test_both_sides_threw_ignores_dom_noise(self) -> None:
        # exception=equal なら dom_mutation=equal が併存しても both-sides-threw (jsdom では dom が常に non-N/A)
        assert (
            derive_verdict_reason([obs(_EQ, Oracle.EXCEPTION), obs(_EQ, Oracle.DOM_MUTATION)], Verdict.INCONCLUSIVE)
            == "both-sides-threw"
        )


class _StubChecker:
    """Port スタブ。固定結果を返す"""

    def __init__(self, result: EquivalenceCheckResult) -> None:
        self._result = result
        self.last_input: EquivalenceInput | None = None
        self.last_batch: list[EquivalenceInput] | None = None

    def check(self, input_: EquivalenceInput) -> EquivalenceCheckResult:
        self.last_input = input_
        return self._result

    def check_batch(self, items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
        self.last_batch = list(items)
        return [self._result.model_copy(update={"id": item.id}) for item in items]


class TestEquivalenceVerificationUseCase:
    def test_delegates_to_checker(self) -> None:
        expected = EquivalenceCheckResult(
            verdict=Verdict.EQUAL,
            observations=[obs(OracleVerdict.EQUAL)],
        )
        stub = _StubChecker(expected)
        use_case = EquivalenceVerificationUseCase(stub)

        input_ = EquivalenceInput(before="1", after="1")
        result = use_case.verify(input_)

        assert stub.last_input == input_
        assert result.verdict is Verdict.EQUAL

    def test_recomputes_overall_verdict(self) -> None:
        """Checker が誤った verdict を返しても use case 側で再計算される"""
        wrong = EquivalenceCheckResult(
            verdict=Verdict.EQUAL,  # 嘘の verdict
            observations=[
                obs(OracleVerdict.NOT_EQUAL),
                obs(OracleVerdict.EQUAL, Oracle.ARGUMENT_MUTATION),
            ],
        )
        use_case = EquivalenceVerificationUseCase(_StubChecker(wrong))
        result = use_case.verify(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.NOT_EQUAL

    def test_passthrough_error_without_observations(self) -> None:
        err = EquivalenceCheckResult(
            verdict=Verdict.ERROR,
            observations=[],
            verdict_reason="executor-error",
            error_message="node runner crashed",
        )
        use_case = EquivalenceVerificationUseCase(_StubChecker(err))
        result = use_case.verify(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.error_message == "node runner crashed"
        assert result.verdict_reason == "executor-error"

    def test_recomputes_verdict_reason_for_inconclusive(self) -> None:
        """Checker が嘘の verdict/reason を返しても use case 側で再計算される"""
        wrong = EquivalenceCheckResult(
            verdict=Verdict.EQUAL,  # 嘘の verdict
            verdict_reason=None,
            observations=[
                obs(OracleVerdict.NOT_APPLICABLE),
                obs(OracleVerdict.EQUAL, Oracle.EXCEPTION),
                obs(OracleVerdict.NOT_APPLICABLE, Oracle.EXTERNAL_OBSERVATION),
            ],
        )
        use_case = EquivalenceVerificationUseCase(_StubChecker(wrong))
        result = use_case.verify(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.INCONCLUSIVE
        assert result.verdict_reason == "both-sides-threw"


class TestVerifyBatch:
    def test_batch_delegates_to_check_batch(self) -> None:
        expected = EquivalenceCheckResult(
            verdict=Verdict.EQUAL,
            observations=[obs(OracleVerdict.EQUAL)],
        )
        stub = _StubChecker(expected)
        use_case = EquivalenceVerificationUseCase(stub)

        inputs = [
            EquivalenceInput(id="a", before="1", after="1"),
            EquivalenceInput(id="b", before="2", after="2"),
        ]
        results = use_case.verify_batch(inputs)

        assert stub.last_batch is not None
        assert [i.id for i in stub.last_batch] == ["a", "b"]
        assert [r.id for r in results] == ["a", "b"]
        assert all(r.verdict is Verdict.EQUAL for r in results)

    def test_batch_recomputes_verdict(self) -> None:
        wrong = EquivalenceCheckResult(
            verdict=Verdict.EQUAL,  # 嘘の verdict
            observations=[obs(OracleVerdict.NOT_EQUAL)],
        )
        use_case = EquivalenceVerificationUseCase(_StubChecker(wrong))
        results = use_case.verify_batch([EquivalenceInput(id="a", before="1", after="1")])
        assert results[0].verdict is Verdict.NOT_EQUAL

    def test_batch_passthrough_error_without_observations(self) -> None:
        err = EquivalenceCheckResult(
            verdict=Verdict.ERROR,
            observations=[],
            error_message="subprocess crashed",
        )
        use_case = EquivalenceVerificationUseCase(_StubChecker(err))
        results = use_case.verify_batch([EquivalenceInput(id="a", before="1", after="1")])
        assert results[0].verdict is Verdict.ERROR
        assert results[0].error_message == "subprocess crashed"

    def test_batch_preserves_effective_timeout_ms(self) -> None:
        result_with_echo = EquivalenceCheckResult(
            verdict=Verdict.EQUAL,
            observations=[obs(OracleVerdict.EQUAL)],
            effective_timeout_ms=3000,
        )
        use_case = EquivalenceVerificationUseCase(_StubChecker(result_with_echo))
        results = use_case.verify_batch(
            [EquivalenceInput(id="a", before="1", after="1", timeout_ms=3000)],
        )
        assert results[0].effective_timeout_ms == 3000
