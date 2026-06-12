"""等価性検証の Use Case 層

1 トリプル (setup, slow, fast) に対して ``EquivalenceCheckerPort`` を呼び出し、
Port から受け取った observation を使って全体 verdict を導出する。

Pruning や同値分割テストといった複数 setup の処理は呼び出し側の責務。
"""

from collections.abc import Sequence

from mb_scanner.domain.entities.equivalence import (
    EquivalenceCheckResult,
    EquivalenceInput,
    Oracle,
    OracleObservation,
    OracleVerdict,
    Verdict,
)
from mb_scanner.domain.ports.equivalence_checker import EquivalenceCheckerPort

# positive な等価エビデンスを与える oracle 集合 (ADR-0018)。
# これらのいずれかが non-not_applicable のときだけ全体を equal にできる。
# dom_mutation oracle は「両側とも DOM を変更しなかった → N/A」(capture.dom_changed を見る) ため、
# non-N/A は「少なくとも片側が DOM を実際に変更した」= positive evidence。
# exception (両側同じくクラッシュ) / external_observation (scaffolding global ノイズ) は単独では positive と見なさない。
_POSITIVE_EVIDENCE_ORACLES = frozenset(
    {Oracle.RETURN_VALUE, Oracle.ARGUMENT_MUTATION, Oracle.INTERACTION_TRACE, Oracle.DOM_MUTATION},
)

# inconclusive verdict の理由文字列 (ADR-0018)。equal / not_equal では None。
# - no-observable-channel: 全 oracle が not_applicable
# - both-sides-threw     : exception oracle が equal (= 両側が同じ例外で落ちた)。positive evidence 無し、
#                          または唯一の positive evidence が dom_mutation だけ (bootstrap 由来とみなす)
# - no-positive-evidence : 例外も無く positive-evidence oracle (return_value/argument_mutation/interaction_trace/
#                          dom_mutation) がすべて not_applicable (external_observation だけが equal 等)
# setup-failure / executor-error は error verdict 用で、checker / Gateway / batch CLI が直接セットする
# (derive_verdict_reason は返さない)。両者は executor の throw phase で区別する:
# - setup-failure : setup 段階 (vm.runInContext(setup, ...)) の throw。SandboxSetupError 由来 (ADR-0023 §D-β)。
# - executor-error: workload 段階以降の executor crash / serialize 失敗 / Gateway・CLI 層の pipeline 失敗。
VERDICT_REASON_NO_OBSERVABLE_CHANNEL = "no-observable-channel"
VERDICT_REASON_BOTH_SIDES_THREW = "both-sides-threw"
VERDICT_REASON_NO_POSITIVE_EVIDENCE = "no-positive-evidence"
VERDICT_REASON_SETUP_FAILURE = "setup-failure"
VERDICT_REASON_EXECUTOR_ERROR = "executor-error"


def derive_overall_verdict(observations: list[OracleObservation]) -> Verdict:
    """Oracle observation から全体 verdict を導く純粋関数 (ADR-0018)

    優先順位:
        1. not_equal が 1 つでもある → not_equal
        2. error が 1 つでもある → error
        3. 全 oracle が not_applicable → inconclusive（観測チャネルゼロ）
        4. not_equal/error 無し かつ positive-evidence oracle
           ({return_value, argument_mutation, interaction_trace, dom_mutation}) がすべて not_applicable
           → inconclusive（差は観測されなかったが積極的等価エビデンスが無い）
        5. exception=equal（両側同じく落ちた）かつ唯一の positive evidence が dom_mutation のみ
           → inconclusive（その DOM 変化は workload でなく bootstrap 由来の可能性が高い = 弱い equal）
        6. それ以外 → equal
    """
    verdicts = [o.verdict for o in observations]
    if OracleVerdict.NOT_EQUAL in verdicts:
        return Verdict.NOT_EQUAL
    if OracleVerdict.ERROR in verdicts:
        return Verdict.ERROR
    if all(v == OracleVerdict.NOT_APPLICABLE for v in verdicts):
        return Verdict.INCONCLUSIVE
    positive_evidence = [
        o for o in observations if o.oracle in _POSITIVE_EVIDENCE_ORACLES and o.verdict != OracleVerdict.NOT_APPLICABLE
    ]
    if not positive_evidence:
        return Verdict.INCONCLUSIVE
    # 保守化: 両側同じく落ちた (exception=equal) かつ唯一の positive evidence が dom_mutation のみ →
    # その DOM 変化は workload 実行でなく bootstrap (Angular compile step 等) の可能性が高い = 弱い equal
    # → inconclusive(both-sides-threw) に倒す。C1 は exception 時に必ず N/A、C4/C6 が non-N/A なら workload が
    # 部分的にでも exercise されたと見なせるので equal を保つ。
    exception = next((o for o in observations if o.oracle is Oracle.EXCEPTION), None)
    only_dom_evidence = len(positive_evidence) == 1 and positive_evidence[0].oracle is Oracle.DOM_MUTATION
    if exception is not None and exception.verdict == OracleVerdict.EQUAL and only_dom_evidence:
        return Verdict.INCONCLUSIVE
    return Verdict.EQUAL


def derive_verdict_reason(observations: list[OracleObservation], verdict: Verdict) -> str | None:
    """``derive_overall_verdict`` が inconclusive を返した理由を分類する (ADR-0018)

    inconclusive 以外の verdict では None を返す。
    """
    if verdict is not Verdict.INCONCLUSIVE:
        return None
    if all(o.verdict == OracleVerdict.NOT_APPLICABLE for o in observations):
        return VERDICT_REASON_NO_OBSERVABLE_CHANNEL
    # inconclusive かつ非 N/A の oracle がある時点で not_equal/error は無いので exception は N/A か equal。
    # equal なら「両側が同じ例外で落ちた」(jsdom では dom_mutation=equal も常に付くがノイズなので無視)。
    exception = next((o for o in observations if o.oracle is Oracle.EXCEPTION), None)
    if exception is not None and exception.verdict == OracleVerdict.EQUAL:
        return VERDICT_REASON_BOTH_SIDES_THREW
    return VERDICT_REASON_NO_POSITIVE_EVIDENCE


class EquivalenceVerificationUseCase:
    """等価性検証 Use Case

    Args:
        checker: EquivalenceCheckerPort 実装（通常は NodeRunnerEquivalenceGateway）
    """

    def __init__(self, checker: EquivalenceCheckerPort) -> None:
        self._checker = checker

    def verify(self, input_: EquivalenceInput) -> EquivalenceCheckResult:
        """1 トリプルを検証して結果を返す

        Port から受け取った結果の verdict フィールドは信頼せず、observation から
        ``derive_overall_verdict`` で再計算する。これにより Port 実装側のバグや
        TypeScript / Python の列挙値ズレを use case で検知できる。
        """
        result = self._checker.check(input_)
        return _finalize(result)

    def verify_batch(self, items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
        """複数トリプルをまとめて検証して結果リストを返す

        Port の ``check_batch`` を呼び、各結果に ``verify`` と同じ verdict 再計算と
        error 素通し防御を適用する。``id`` は Port が埋めたものを保持する。
        """
        results = self._checker.check_batch(items)
        return [_finalize(result) for result in results]


def _finalize(result: EquivalenceCheckResult) -> EquivalenceCheckResult:
    """Port から受け取った結果を verdict 再計算して確定する共通処理"""
    # 観測ゼロの失敗結果 (checker / Gateway / batch CLI が ERROR verdict + setup-failure /
    # executor-error 分類を直接セットしたもの) は再計算をバイパスする。再計算に通すと
    # derive_overall_verdict([]) が INCONCLUSIVE を返し、ERROR と理由分類が上書きされてしまう。
    # AND の両辺が必要: error_message だけでは観測付き error (oracle 段の失敗) まで素通しになり、
    # observations 空だけでは error_message 無しの不正結果を素通ししてしまう。
    # 判断: ai-guide/adr/0018-equivalence-verdict-conservative.md
    if result.error_message is not None and not result.observations:
        return result

    recalculated = derive_overall_verdict(result.observations)
    return EquivalenceCheckResult(
        id=result.id,
        verdict=recalculated,
        observations=result.observations,
        verdict_reason=derive_verdict_reason(result.observations, recalculated),
        error_message=result.error_message,
        effective_timeout_ms=result.effective_timeout_ms,
    )
