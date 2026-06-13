"""等価性検証モデルの Pydantic バリデーションテスト"""

import json

from pydantic import ValidationError
import pytest

from mb_scanner.domain.entities.equivalence import (
    MAX_CODE_LENGTH,
    EquivalenceCheckResult,
    EquivalenceInput,
    ExecutionEnvironment,
    Oracle,
    OracleObservation,
    OracleVerdict,
    Verdict,
)


class TestEnums:
    """TypeScript 側 (contracts/equivalence-contracts.ts) と文字列値が揃っていること"""

    def test_verdict_values(self) -> None:
        assert Verdict.EQUAL.value == "equal"
        assert Verdict.NOT_EQUAL.value == "not_equal"
        assert Verdict.INCONCLUSIVE.value == "inconclusive"
        assert Verdict.ERROR.value == "error"
        assert {v.value for v in Verdict} == {"equal", "not_equal", "inconclusive", "error"}

    def test_oracle_verdict_values(self) -> None:
        assert OracleVerdict.NOT_APPLICABLE.value == "not_applicable"
        assert {v.value for v in OracleVerdict} == {"equal", "not_equal", "not_applicable", "error"}

    def test_oracle_values(self) -> None:
        assert {o.value for o in Oracle} == {
            "return_value",
            "argument_mutation",
            "exception",
            "external_observation",
            "dom_mutation",
            "interaction_trace",
        }

    def test_execution_environment_values(self) -> None:
        assert {e.value for e in ExecutionEnvironment} == {"vm", "jsdom"}


class TestEquivalenceInput:
    def test_minimal_input(self) -> None:
        inp = EquivalenceInput(before="1", after="2")
        assert inp.setup == ""
        assert inp.timeout_ms == 5000

    def test_full_input(self) -> None:
        inp = EquivalenceInput(setup="const x=1;", before="x", after="x", timeout_ms=3000)
        assert inp.setup == "const x=1;"
        assert inp.timeout_ms == 3000

    def test_timeout_lower_bound(self) -> None:
        with pytest.raises(ValidationError):
            EquivalenceInput(before="1", after="1", timeout_ms=0)

    def test_timeout_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            EquivalenceInput(before="1", after="1", timeout_ms=60_001)

    def test_code_length_bound(self) -> None:
        long = "x" * (MAX_CODE_LENGTH + 1)
        with pytest.raises(ValidationError):
            EquivalenceInput(before=long, after="1")

    def test_bundled_lib_code_within_bound(self) -> None:
        # Selakovic 作用点 A の clientIssue は bundled ライブラリを before/after に丸ごと埋める (数 MB)
        big = "x" * 3_000_000
        inp = EquivalenceInput(before=big, after=big)
        assert len(inp.before) == 3_000_000

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            EquivalenceInput.model_validate({"before": "1", "after": "1", "unknown": 1})

    def test_id_default_none(self) -> None:
        inp = EquivalenceInput(before="1", after="1")
        assert inp.id is None

    def test_environment_and_module_base_dir(self) -> None:
        inp = EquivalenceInput(before="1", after="1", environment=ExecutionEnvironment.JSDOM, module_base_dir="/x/y")
        assert inp.environment == ExecutionEnvironment.JSDOM
        assert inp.module_base_dir == "/x/y"

    def test_environment_defaults_none(self) -> None:
        inp = EquivalenceInput(before="1", after="1")
        assert inp.environment is None
        assert inp.module_base_dir is None

    def test_environment_string_round_trip(self) -> None:
        inp = EquivalenceInput.model_validate({"before": "1", "after": "1", "environment": "jsdom"})
        assert inp.environment == ExecutionEnvironment.JSDOM

    def test_mount_html_round_trip(self) -> None:
        inp = EquivalenceInput.model_validate(
            {
                "before": "1",
                "after": "1",
                "mount_html": "<div id='demo'></div>",
            }
        )
        assert inp.mount_html == "<div id='demo'></div>"

    def test_mount_html_default_none(self) -> None:
        inp = EquivalenceInput(before="1", after="1")
        assert inp.mount_html is None

    def test_id_round_trip(self) -> None:
        inp = EquivalenceInput(id="case-001", before="1", after="1", timeout_ms=3000)
        dumped = json.loads(inp.model_dump_json())
        assert dumped["id"] == "case-001"
        assert dumped["timeout_ms"] == 3000
        parsed = EquivalenceInput.model_validate(dumped)
        assert parsed.id == "case-001"

    def test_timeout_ms_always_in_json(self) -> None:
        """デフォルト値でも JSON には必ず timeout_ms が含まれる (Python→Node 受け渡し保険)"""
        inp = EquivalenceInput(before="1", after="1")
        dumped = json.loads(inp.model_dump_json())
        assert "timeout_ms" in dumped
        assert dumped["timeout_ms"] == 5000

    def test_workload_default_none(self) -> None:
        """ADR-0023 D-β: workload は changed-fn 経路でのみ定義、旧経路は None のまま"""
        inp = EquivalenceInput(before="1", after="1")
        assert inp.workload is None

    def test_workload_round_trip(self) -> None:
        """changed-fn 経路の placeholder substitution + 4 値契約 (ADR-0023 D-β)"""
        inp = EquivalenceInput(
            setup="var lib = { f: function () { $BODY$ } };",
            before="__OBS__.push(1); return 1;",
            after="__OBS__.push(2); return 2;",
            workload="(function(){ __OBS__ = []; lib.f(); return JSON.stringify(__OBS__); })()",
        )
        assert inp.workload is not None
        dumped = json.loads(inp.model_dump_json())
        # null 値も JSON に乗ること (TS 側で `workload != null` 判定するため、key 自体は必須)
        assert "workload" in dumped
        assert dumped["workload"] == inp.workload
        parsed = EquivalenceInput.model_validate(dumped)
        assert parsed.workload == inp.workload

    def test_workload_null_in_json(self) -> None:
        """Workload が None のとき JSON では null として出力される (TS 側の `!= null` 判定の前提)"""
        inp = EquivalenceInput(before="1", after="1")
        dumped = json.loads(inp.model_dump_json())
        assert "workload" in dumped
        assert dumped["workload"] is None

    def test_workload_length_bound(self) -> None:
        too_long = "x" * (MAX_CODE_LENGTH + 1)
        with pytest.raises(ValidationError):
            EquivalenceInput(before="1", after="1", workload=too_long)


class TestOracleObservation:
    def test_round_trip(self) -> None:
        obs = OracleObservation(
            oracle=Oracle.RETURN_VALUE,
            verdict=OracleVerdict.NOT_EQUAL,
            before_value="-1",
            after_value="1",
            detail=None,
        )
        payload = obs.model_dump_json()
        parsed = OracleObservation.model_validate_json(payload)
        assert parsed == obs

    def test_parse_from_typescript_payload(self) -> None:
        """TypeScript 側 JSON 出力例を Pydantic がそのまま解釈できる"""
        ts_payload = {
            "oracle": "return_value",
            "verdict": "not_equal",
            "before_value": "-1",
            "after_value": "1",
        }
        obs = OracleObservation.model_validate(ts_payload)
        assert obs.oracle is Oracle.RETURN_VALUE
        assert obs.verdict is OracleVerdict.NOT_EQUAL


class TestEquivalenceCheckResult:
    def test_equal_result(self) -> None:
        payload = {
            "verdict": "equal",
            "observations": [
                {"oracle": "return_value", "verdict": "equal", "before_value": "2", "after_value": "2"},
                {"oracle": "argument_mutation", "verdict": "not_applicable"},
                {"oracle": "exception", "verdict": "not_applicable"},
                {"oracle": "external_observation", "verdict": "not_applicable"},
            ],
        }
        result = EquivalenceCheckResult.model_validate(payload)
        assert result.verdict is Verdict.EQUAL
        assert len(result.observations) == 4

    def test_error_with_message(self) -> None:
        result = EquivalenceCheckResult(verdict=Verdict.ERROR, observations=[], error_message="boom")
        dumped = json.loads(result.model_dump_json())
        assert dumped["verdict"] == "error"
        assert dumped["error_message"] == "boom"

    def test_ignore_extra_fields_from_ts(self) -> None:
        """extra='ignore' により TypeScript 側が新フィールドを増やしても壊れない"""
        payload = {
            "verdict": "equal",
            "observations": [],
            "future_field": 123,
        }
        result = EquivalenceCheckResult.model_validate(payload)
        assert result.verdict is Verdict.EQUAL

    def test_id_and_effective_timeout_ms_from_ts(self) -> None:
        """Node 側 (バッチ API) が吐く id / effective_timeout_ms を受け取れる"""
        payload = {
            "id": "case-001",
            "verdict": "equal",
            "observations": [],
            "effective_timeout_ms": 3000,
        }
        result = EquivalenceCheckResult.model_validate(payload)
        assert result.id == "case-001"
        assert result.effective_timeout_ms == 3000

    def test_verdict_reason_default_none(self) -> None:
        result = EquivalenceCheckResult(verdict=Verdict.EQUAL, observations=[])
        assert result.verdict_reason is None

    def test_inconclusive_with_verdict_reason_from_ts(self) -> None:
        payload = {
            "verdict": "inconclusive",
            "observations": [{"oracle": "exception", "verdict": "equal"}],
            "verdict_reason": "both-sides-threw",
        }
        result = EquivalenceCheckResult.model_validate(payload)
        assert result.verdict is Verdict.INCONCLUSIVE
        assert result.verdict_reason == "both-sides-threw"
        dumped = json.loads(result.model_dump_json())
        assert dumped["verdict_reason"] == "both-sides-threw"
