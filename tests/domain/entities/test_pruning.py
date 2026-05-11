"""Pruning モデル (Hydra 式 AST 差分フィルタ) の Pydantic バリデーションテスト

対象: mb_scanner.domain.entities.pruning
観点: TypeScript 側 (contracts/pruning-contracts.ts) と JSON 契約が揃っていること、
      ``PruningInput`` の境界バリデーション + 等価検証コンテキスト (environment 等) の pass-through、
      ``PruningResult`` の verdict 別表現、``extra`` 設定 (input=forbid / result=ignore) が期待通り機能すること
"""

import json

from pydantic import ValidationError
import pytest

from mb_scanner.domain.entities.pruning import (
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
        inp = PruningInput(slow="arr[0]", fast="arr[1]")
        assert inp.setup == ""
        assert inp.timeout_ms == 5000
        assert inp.max_iterations == 1000
        assert inp.id is None

    def test_full_input(self) -> None:
        inp = PruningInput(
            id="case-001",
            slow="arr[0]",
            fast="arr[1]",
            setup="const arr = [1, 2, 3];",
            timeout_ms=3000,
            max_iterations=100,
        )
        assert inp.setup == "const arr = [1, 2, 3];"
        assert inp.timeout_ms == 3000
        assert inp.max_iterations == 100

    def test_timeout_lower_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(slow="x", fast="x", timeout_ms=0)

    def test_timeout_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(slow="x", fast="x", timeout_ms=60_001)

    def test_max_iterations_lower_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(slow="x", fast="x", max_iterations=0)

    def test_max_iterations_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput(slow="x", fast="x", max_iterations=100_001)

    def test_code_length_bound(self) -> None:
        long = "x" * 1_000_001
        with pytest.raises(ValidationError):
            PruningInput(slow=long, fast="x")

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            PruningInput.model_validate({"slow": "x", "fast": "x", "unknown": 1})

    def test_id_round_trip(self) -> None:
        inp = PruningInput(id="case-001", slow="x", fast="y", timeout_ms=3000)
        dumped = json.loads(inp.model_dump_json())
        assert dumped["id"] == "case-001"
        assert dumped["timeout_ms"] == 3000
        parsed = PruningInput.model_validate(dumped)
        assert parsed.id == "case-001"

    def test_timeout_ms_always_in_json(self) -> None:
        """デフォルト値でも JSON には必ず timeout_ms が含まれる (Python→Node 受け渡し保険)"""
        inp = PruningInput(slow="x", fast="x")
        dumped = json.loads(inp.model_dump_json())
        assert "timeout_ms" in dumped
        assert dumped["timeout_ms"] == 5000


class TestPruningInputEquivalenceContext:
    """``PruningInput`` が等価検証コンテキストを pass-through で受け取れること。

    対象フィールド: environment / module_base_dir / mount_html / aspect / candidate_kind /
    enclosure_type。pruning 本体は解釈しないが、Node の prune-batch が wire format として
    受け付ける必要がある。
    """

    def test_defaults_are_none(self) -> None:
        inp = PruningInput(slow="x", fast="x")
        assert inp.environment is None
        assert inp.module_base_dir is None
        assert inp.mount_html is None
        assert inp.aspect is None
        assert inp.candidate_kind is None
        assert inp.enclosure_type is None

    def test_accepts_and_round_trips(self) -> None:
        payload = {
            "slow": "x",
            "fast": "x",
            "timeout_ms": 5000,
            "environment": "jsdom",
            "module_base_dir": "/abs/data/selakovic-2016-issues/serverIssues/ChalkIssues/issues/issue_28",
            "mount_html": '<div id="demo"></div>',
            "aspect": "A",
            "candidate_kind": "single",
            "enclosure_type": "server-test-case",
        }
        inp = PruningInput.model_validate(payload)
        assert inp.environment == "jsdom"
        assert inp.module_base_dir == payload["module_base_dir"]
        assert inp.mount_html == '<div id="demo"></div>'
        assert inp.aspect == "A"
        assert inp.candidate_kind == "single"
        assert inp.enclosure_type == "server-test-case"
        dumped = json.loads(inp.model_dump_json())
        assert PruningInput.model_validate(dumped) == inp


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
            "node_count_before": 10,
            "node_count_after": 3,
            "effective_timeout_ms": 5000,
        }
        result = PruningResult.model_validate(payload)
        assert result.verdict is PruningVerdict.PRUNED
        assert len(result.placeholders) == 1
        assert result.placeholders[0].kind is PlaceholderKind.EXPRESSION

    def test_initial_mismatch_result(self) -> None:
        """Slow ≢ fast で pruning 前段停止のケースは pattern 系が無くても成立する"""
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
