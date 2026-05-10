"""Preprocessing (Selakovic 前処理) モデルの Pydantic バリデーションテスト

TypeScript 側 (`mb-analyzer/src/contracts/preprocessing-contracts.ts`) と列挙値文字列・
フィールド名が揃っていることを確認する。
"""

from pydantic import ValidationError
import pytest

from mb_scanner.domain.entities.preprocessing import (
    Aspect,
    CandidateKind,
    ExclusionReason,
    ExecutionEnvironmentHint,
    LayoutKind,
    PreprocessingInput,
    PreprocessingResult,
)


class TestEnums:
    def test_layout_kind_values(self) -> None:
        assert {k.value for k in LayoutKind} == {"client", "server", "unknown"}

    def test_exclusion_reason_values(self) -> None:
        assert "parse-error" in {r.value for r in ExclusionReason}
        assert "layout-unknown" in {r.value for r in ExclusionReason}

    def test_aspect_values(self) -> None:
        assert Aspect.LIB.value == "A"
        assert Aspect.BODY.value == "B"
        assert Aspect.BOTH.value == "A+B"
        assert Aspect.FALLBACK.value == "fallback"

    def test_candidate_kind_values(self) -> None:
        assert {k.value for k in CandidateKind} == {"lib", "body", "single"}

    def test_execution_environment_hint_values(self) -> None:
        assert {e.value for e in ExecutionEnvironmentHint} == {"vm", "jsdom"}


class TestPreprocessingInput:
    def test_minimal(self) -> None:
        inp = PreprocessingInput(issue_dir="/x")
        assert inp.id is None
        assert inp.issue_dir == "/x"

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            PreprocessingInput.model_validate({"issue_dir": "/x", "unknown": 1})


class TestPreprocessingResult:
    def test_extracted_with_new_fields(self) -> None:
        r = PreprocessingResult.model_validate(
            {
                "layout": "client",
                "setup": "var x=1;",
                "slow": "x",
                "fast": "x",
                "enclosure_type": "f1-body",
                "aspect": "A+B",
                "candidate_kind": "body",
                "environment": "jsdom",
            }
        )
        assert r.aspect == Aspect.BOTH
        assert r.candidate_kind == CandidateKind.BODY
        assert r.environment == ExecutionEnvironmentHint.JSDOM

    def test_excluded(self) -> None:
        r = PreprocessingResult.model_validate(
            {"layout": "unknown", "excluded": "layout-unknown", "excluded_detail": "no v_*.html"}
        )
        assert r.excluded == ExclusionReason.LAYOUT_UNKNOWN
        assert r.slow is None

    def test_unknown_fields_ignored(self) -> None:
        # Node 側の将来フィールド追加に備えて extra="ignore"
        r = PreprocessingResult.model_validate({"layout": "server", "future_field": 42})
        assert r.layout == LayoutKind.SERVER

    def test_new_fields_default_none(self) -> None:
        r = PreprocessingResult.model_validate({"layout": "server"})
        assert r.aspect is None
        assert r.candidate_kind is None
        assert r.environment is None
