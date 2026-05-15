"""Preprocessing (Selakovic 前処理) モデルの Pydantic バリデーションテスト (ADR-0024)

TypeScript 側 (``mb-analyzer/src/contracts/preprocessing-contracts.ts``) と列挙値文字列・
フィールド名が揃っていることを確認する。
"""

from pydantic import ValidationError
import pytest

from mb_scanner.domain.entities.preprocessing import (
    Aspect,
    ExclusionReasonBase,
    LayoutKind,
    PreprocessingCandidate,
    PreprocessingInput,
    PreprocessingIssueResult,
    SelakovicCandidateMeta,
    SelakovicExclusionReason,
    SelakovicIssueMeta,
    TargetSide,
    WrapperKind,
)


class TestEnums:
    def test_layout_kind_values(self) -> None:
        assert {k.value for k in LayoutKind} == {"client", "server", "unknown"}

    def test_exclusion_reason_base_values(self) -> None:
        assert {r.value for r in ExclusionReasonBase} == {
            "parse-error",
            "no-changed-nodes",
            "multi-file-change",
            "missing-files",
        }

    def test_selakovic_exclusion_reason_values(self) -> None:
        assert {r.value for r in SelakovicExclusionReason} == {
            "module-wide-change",
            "no-enclosure-candidate",
            "layout-unknown",
            "change-not-exercised",
        }

    def test_aspect_values(self) -> None:
        assert Aspect.LIB.value == "lib"
        assert Aspect.WORKLOAD.value == "workload"
        assert Aspect.BOTH.value == "lib+workload"
        assert Aspect.FALLBACK.value == "fallback"

    def test_target_side_values(self) -> None:
        assert {k.value for k in TargetSide} == {"lib", "workload", "both"}

    def test_wrapper_kind_values(self) -> None:
        assert {k.value for k in WrapperKind} == {"top_level", "angular_controller_wrapper"}


class TestPreprocessingInput:
    def test_minimal(self) -> None:
        inp = PreprocessingInput(issue_dir="/x")
        assert inp.id is None
        assert inp.issue_dir == "/x"

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            PreprocessingInput.model_validate({"issue_dir": "/x", "unknown": 1})


class TestSelakovicAdapterMeta:
    def test_issue_meta_minimal(self) -> None:
        m = SelakovicIssueMeta(
            adapter="selakovic",
            layout=LayoutKind.CLIENT,
            aspect=Aspect.LIB,
            wrapper_kind=WrapperKind.TOP_LEVEL,
        )
        assert m.adapter == "selakovic"
        assert m.layout == LayoutKind.CLIENT
        assert m.aspect == Aspect.LIB

    def test_candidate_meta_minimal(self) -> None:
        m = SelakovicCandidateMeta(
            adapter="selakovic",
            target_side=TargetSide.LIB,
            is_workload_reachable=True,
        )
        assert m.target_side == TargetSide.LIB
        assert m.is_workload_reachable is True


class TestPreprocessingCandidate:
    def test_extracted_with_meta(self) -> None:
        c = PreprocessingCandidate.model_validate(
            {
                "setup": "var x=1;",
                "slow": "x",
                "fast": "x",
                "enclosure_node_type": "FunctionExpression",
                "candidate_meta": {
                    "adapter": "selakovic",
                    "target_side": "lib",
                    "is_workload_reachable": True,
                },
            },
        )
        assert c.setup == "var x=1;"
        assert c.candidate_meta.target_side == TargetSide.LIB
        assert c.candidate_meta.is_workload_reachable is True
        assert c.enclosure_node_type == "FunctionExpression"

    def test_excluded_candidate(self) -> None:
        c = PreprocessingCandidate.model_validate(
            {
                "candidate_excluded": "change-not-exercised",
                "candidate_meta": {
                    "adapter": "selakovic",
                    "target_side": "lib",
                    "is_workload_reachable": False,
                },
            },
        )
        assert c.candidate_excluded == SelakovicExclusionReason.CHANGE_NOT_EXERCISED
        assert c.slow is None


class TestPreprocessingIssueResult:
    def test_extracted_issue_with_one_candidate(self) -> None:
        r = PreprocessingIssueResult.model_validate(
            {
                "id": "case-01",
                "candidates": [
                    {
                        "setup": "var x=1;",
                        "slow": "x",
                        "fast": "x",
                        "candidate_meta": {
                            "adapter": "selakovic",
                            "target_side": "workload",
                            "is_workload_reachable": False,
                        },
                    },
                ],
                "candidate_count": 1,
                "issue_meta": {
                    "adapter": "selakovic",
                    "layout": "client",
                    "aspect": "workload",
                    "wrapper_kind": "top_level",
                },
            },
        )
        assert r.id == "case-01"
        assert r.candidate_count == 1
        assert len(r.candidates) == 1
        assert r.candidates[0].candidate_meta.target_side == TargetSide.WORKLOAD
        assert r.issue_meta is not None
        assert r.issue_meta.aspect == Aspect.WORKLOAD

    def test_issue_excluded(self) -> None:
        r = PreprocessingIssueResult.model_validate(
            {
                "issue_excluded": "layout-unknown",
                "issue_excluded_detail": "no v_*.html",
                "candidates": [],
                "candidate_count": 0,
                "issue_meta": {
                    "adapter": "selakovic",
                    "layout": "unknown",
                    "aspect": "fallback",
                    "wrapper_kind": "top_level",
                },
            },
        )
        assert r.issue_excluded == SelakovicExclusionReason.LAYOUT_UNKNOWN
        assert r.candidate_count == 0
        assert len(r.candidates) == 0

    def test_unknown_fields_ignored(self) -> None:
        r = PreprocessingIssueResult.model_validate(
            {
                "candidates": [],
                "candidate_count": 0,
                "future_field": 42,
                "issue_meta": {
                    "adapter": "selakovic",
                    "layout": "server",
                    "aspect": "lib",
                    "wrapper_kind": "top_level",
                },
            },
        )
        assert r.issue_meta is not None
        assert r.issue_meta.layout == LayoutKind.SERVER

    def test_issue_meta_optional_for_gateway_error(self) -> None:
        # gateway error 時 (subprocess 失敗等) は issue_meta を埋められないことがある
        r = PreprocessingIssueResult.model_validate(
            {
                "id": "case-01",
                "issue_excluded": "layout-unknown",
                "issue_excluded_detail": "subprocess failed",
                "candidates": [],
                "candidate_count": 0,
            },
        )
        assert r.issue_meta is None
        assert r.issue_excluded == SelakovicExclusionReason.LAYOUT_UNKNOWN

    def test_base_excluded_reason_accepted(self) -> None:
        # base ExclusionReasonBase の値も受け付ける
        r = PreprocessingIssueResult.model_validate(
            {
                "issue_excluded": "parse-error",
                "issue_excluded_detail": "syntax error",
                "candidates": [],
                "candidate_count": 0,
            },
        )
        assert r.issue_excluded == ExclusionReasonBase.PARSE_ERROR
