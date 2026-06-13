"""Pruning モデル (Hydra 式 AST 差分フィルタ) の Pydantic バリデーションテスト

対象: mb_scanner.pruning.models
観点: TypeScript 側 (contracts/pruning-contracts.ts) と JSON 契約が揃っていること、
      ``PruningInput`` の境界バリデーション + 等価検証コンテキスト (environment 等) の pass-through、
      ``PruningResult`` の verdict 別表現、``extra`` 設定 (input=forbid / result=ignore) が期待通り機能すること
"""

import json

from pydantic import ValidationError
import pytest

from mb_scanner.pruning.models import (
    MAX_CODE_LENGTH,
    Placeholder,
    PlaceholderKind,
    PruningInput,
    PruningResult,
    PruningVerdict,
)


class TestEnums:
    """TypeScript 側 (shared/types.ts の PRUNING_VERDICT / PLACEHOLDER_KIND) と揃っている"""

    def test_pruning_verdict_values(self) -> None:
        assert PruningVerdict.PRUNED.value == "pruned"
        assert PruningVerdict.INITIAL_MISMATCH.value == "initial_mismatch"
        assert PruningVerdict.ERROR.value == "error"
        assert {v.value for v in PruningVerdict} == {"pruned", "initial_mismatch", "error"}

    def test_placeholder_kind_values(self) -> None:
        assert {k.value for k in PlaceholderKind} == {"expression", "statement", "identifier"}


class TestPruningInput:
    def test_minimal_input(self) -> None:
        inp = PruningInput(before="arr[0]", after="arr[1]")
        assert inp.setup == ""
        assert inp.timeout_ms == 5000
        assert inp.max_iterations == 1000
        assert inp.id is None

    def test_full_input(self) -> None:
        inp = PruningInput(
            id="case-001",
            before="arr[0]",
            after="arr[1]",
            setup="const arr = [1, 2, 3];",
            timeout_ms=3000,
            max_iterations=100,
        )
        assert inp.setup == "const arr = [1, 2, 3];"
        assert inp.timeout_ms == 3000
        assert inp.max_iterations == 100

    def test_timeout_lower_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(before="x", after="x", timeout_ms=0)

    def test_timeout_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(before="x", after="x", timeout_ms=60_001)

    def test_max_iterations_lower_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(before="x", after="x", max_iterations=0)

    def test_max_iterations_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(before="x", after="x", max_iterations=100_001)

    def test_code_length_bound(self) -> None:
        # MAX_CODE_LENGTH (= 20MB、EquivalenceInput と同じ) を 1 文字でも超えたら ValidationError。
        # setup にも同じ上限がかかる (0022 の changed-fn candidate は lib 全文を setup に残す)。
        too_long = "x" * (MAX_CODE_LENGTH + 1)
        with pytest.raises(ValidationError):
            PruningInput(before=too_long, after="x")
        with pytest.raises(ValidationError):
            PruningInput(before="x", after="x", setup=too_long)
        # ちょうど上限なら OK
        PruningInput(before="x" * MAX_CODE_LENGTH, after="x")

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput.model_validate({"before": "x", "after": "x", "unknown": 1})

    def test_id_round_trip(self) -> None:
        inp = PruningInput(id="case-001", before="x", after="y", timeout_ms=3000)
        dumped = json.loads(inp.model_dump_json())
        assert dumped["id"] == "case-001"
        assert dumped["timeout_ms"] == 3000
        parsed = PruningInput.model_validate(dumped)
        assert parsed.id == "case-001"

    def test_timeout_ms_always_in_json(self) -> None:
        """デフォルト値でも JSON には必ず timeout_ms が含まれる (Python→Node 受け渡し保険)"""
        inp = PruningInput(before="x", after="x")
        dumped = json.loads(inp.model_dump_json())
        assert "timeout_ms" in dumped
        assert dumped["timeout_ms"] == 5000


class TestPruningInputEquivalenceContext:
    """``PruningInput`` が等価検証コンテキストを pass-through で受け取れること。

    対象フィールド: environment / module_base_dir / mount_html。pruning 本体は解釈しないが、
    Node の prune-batch が wire format として受け付ける必要がある。
    """

    def test_defaults_are_none(self) -> None:
        inp = PruningInput(before="x", after="x")
        assert inp.environment is None
        assert inp.module_base_dir is None
        assert inp.mount_html is None

    def test_accepts_and_round_trips(self) -> None:
        payload = {
            "before": "x",
            "after": "x",
            "timeout_ms": 5000,
            "environment": "jsdom",
            "module_base_dir": "/abs/data/selakovic-2016-issues/serverIssues/ChalkIssues/issues/issue_28",
            "mount_html": '<div id="demo"></div>',
        }
        inp = PruningInput.model_validate(payload)
        assert inp.environment == "jsdom"
        assert inp.module_base_dir == payload["module_base_dir"]
        assert inp.mount_html == '<div id="demo"></div>'
        dumped = json.loads(inp.model_dump_json())
        assert PruningInput.model_validate(dumped) == inp

    def test_workload_default_none_and_round_trip(self) -> None:
        """ADR-0023 D-β: workload は changed-fn 経路の pass-through、旧経路は None"""
        inp = PruningInput(before="x", after="x")
        assert inp.workload is None

        payload = {
            "before": "return 1;",
            "after": "return 2;",
            "workload": "(function(){ __OBS__ = []; lib.f(); return JSON.stringify(__OBS__); })()",
        }
        inp2 = PruningInput.model_validate(payload)
        assert inp2.workload == payload["workload"]
        dumped = json.loads(inp2.model_dump_json())
        assert dumped["workload"] == payload["workload"]
        assert PruningInput.model_validate(dumped) == inp2

    def test_workload_length_bound(self) -> None:
        too_long = "x" * (MAX_CODE_LENGTH + 1)
        with pytest.raises(ValidationError):
            PruningInput(before="x", after="x", workload=too_long)


class TestPlaceholder:
    def test_round_trip(self) -> None:
        ph = Placeholder(id="$VAR_1", kind=PlaceholderKind.EXPRESSION, original_snippet="arr[0]")
        payload = ph.model_dump_json()
        parsed = Placeholder.model_validate_json(payload)
        assert parsed == ph

    def test_parse_from_typescript_payload(self) -> None:
        """TypeScript 側 JSON 出力例を Pydantic がそのまま解釈できる"""
        ts_payload = {"id": "$STMT_3", "kind": "statement", "original_snippet": "use(x);"}
        ph = Placeholder.model_validate(ts_payload)
        assert ph.kind is PlaceholderKind.STATEMENT


class TestPruningResult:
    def test_pruned_result(self) -> None:
        payload = {
            "verdict": "pruned",
            "pattern_code": "$VAR_1",
            "placeholders": [
                {"id": "$VAR_1", "kind": "expression", "original_snippet": "arr[0]"},
            ],
            "iterations": 3,
            "node_count_initial": 10,
            "node_count_pruned": 3,
            "effective_timeout_ms": 5000,
        }
        result = PruningResult.model_validate(payload)
        assert result.verdict is PruningVerdict.PRUNED
        assert len(result.placeholders) == 1
        assert result.placeholders[0].kind is PlaceholderKind.EXPRESSION

    def test_initial_mismatch_result(self) -> None:
        """Before ≢ after で pruning 前段停止のケースは pattern 系が無くても成立する"""
        result = PruningResult.model_validate({"verdict": "initial_mismatch"})
        assert result.verdict is PruningVerdict.INITIAL_MISMATCH
        assert result.pattern_code is None
        assert result.placeholders == []

    def test_error_with_message(self) -> None:
        result = PruningResult(verdict=PruningVerdict.ERROR, error_message="parse failed")
        dumped = json.loads(result.model_dump_json())
        assert dumped["verdict"] == "error"
        assert dumped["error_message"] == "parse failed"

    def test_ignore_extra_fields_from_ts(self) -> None:
        """extra='ignore' により TypeScript 側が新フィールドを増やしても壊れない"""
        payload = {"verdict": "pruned", "future_field": 123}
        result = PruningResult.model_validate(payload)
        assert result.verdict is PruningVerdict.PRUNED

    def test_id_and_effective_timeout_ms_from_ts(self) -> None:
        """Node 側 (バッチ API) が吐く id / effective_timeout_ms を受け取れる"""
        payload = {"id": "case-001", "verdict": "pruned", "effective_timeout_ms": 3000}
        result = PruningResult.model_validate(payload)
        assert result.id == "case-001"
        assert result.effective_timeout_ms == 3000
