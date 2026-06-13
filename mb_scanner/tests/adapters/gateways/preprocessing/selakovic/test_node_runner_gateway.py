"""Node ランナー preprocessing Gateway (Selakovic) のテスト (ADR-0024)

- 単体テスト: subprocess をモックして JSONL 往復・エラー経路をカバー
- integration test (`-m integration`): 実際に mb-analyzer/dist/cli.js を呼ぶ

ADR-0024 で 1 入力 → 1 IssueResult モデルに変更 (旧 1 入力 → N flat result から)。
"""

import json
from pathlib import Path
import subprocess
from unittest.mock import patch

import pytest

from mb_scanner.adapters.gateways.preprocessing.selakovic.node_runner_gateway import (
    NodeRunnerPreprocessorGateway,
)
from mb_scanner.domain.entities.preprocessing import (
    PreprocessingInput,
    SelakovicExclusionReason,
)

PROJECT_ROOT = Path(__file__).resolve().parents[5]
CLI_PATH = PROJECT_ROOT / "mb-analyzer" / "dist" / "cli.js"


def _gateway(cli_path: Path | None = None) -> NodeRunnerPreprocessorGateway:
    return NodeRunnerPreprocessorGateway(cli_path or CLI_PATH)


def _fake_issue_result(id_: str | None = None, n_candidates: int = 1) -> dict[str, object]:
    """新 contract (ADR-0024) に合わせた 1 IssueResult fixture。"""
    candidates: list[dict[str, object]] = [
        {
            "setup": "const arr = [1, 2, 3];",
            "before": "arr[0]",
            "after": "arr[1]",
            "enclosure_node_type": "FunctionExpression",
            "candidate_meta": {
                "adapter": "selakovic",
                "target_side": "workload",
                "is_workload_reachable": False,
            },
        }
        for _ in range(n_candidates)
    ]
    payload: dict[str, object] = {
        "candidates": candidates,
        "candidate_count": n_candidates,
        "issue_meta": {
            "adapter": "selakovic",
            "layout": "client",
            "aspect": "workload",
            "wrapper_kind": "top_level",
        },
    }
    if id_ is not None:
        payload["id"] = id_
    return payload


class TestNodeRunnerPreprocessorGatewayMocked:
    def test_returns_error_when_bundle_missing(self, tmp_path: Path) -> None:
        gw = _gateway(tmp_path / "nonexistent.js")
        result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))
        assert result.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN
        assert result.id == "case-01"
        assert result.issue_excluded_detail is not None
        assert "not found" in result.issue_excluded_detail

    def test_parses_single_jsonl_line(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = json.dumps(_fake_issue_result(id_="case-01")) + "\n"
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed) as run_mock:
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))

        assert result.candidate_count == 1
        assert result.candidates[0].before == "arr[0]"
        assert result.candidates[0].after == "arr[1]"
        assert run_mock.call_count == 1

    def test_parses_issue_with_n_candidates(self, tmp_path: Path) -> None:
        # 1 issue 内に複数 candidate (= ADR-0024 の階層化)
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = json.dumps(_fake_issue_result(id_="case-01", n_candidates=3)) + "\n"
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))

        assert result.candidate_count == 3
        assert len(result.candidates) == 3

    def test_skips_invalid_jsonl_lines_but_keeps_valid(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join(
            [
                "this is not json",
                json.dumps(_fake_issue_result(id_="case-01")),
                "{malformed",
            ],
        )
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))

        assert result.id == "case-01"

    def test_subprocess_invoked_with_preprocess_subcommand(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = json.dumps(_fake_issue_result(id_="case-01")) + "\n"
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed) as run_mock:
            gw = _gateway(fake_cli)
            gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))

        cmd = run_mock.call_args.args[0]
        assert cmd[-1] == "preprocess-selakovic"
        assert str(fake_cli) in cmd

    def test_payload_keeps_id_field_as_null_when_none(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = json.dumps(_fake_issue_result()) + "\n"
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed) as run_mock:
            gw = _gateway(fake_cli)
            gw.preprocess(PreprocessingInput(issue_dir="/tmp/x"))

        sent_payload = run_mock.call_args.kwargs["input"]
        parsed = json.loads(sent_payload)
        assert parsed["id"] is None
        assert parsed["issue_dir"] == "/tmp/x"

    def test_subprocess_timeout_returns_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        with patch.object(
            subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="node", timeout=5),
        ):
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))
        assert result.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN
        assert result.id == "case-01"
        assert result.issue_excluded_detail is not None
        assert "timeout" in result.issue_excluded_detail.lower()

    def test_nonzero_exit_returns_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="bad input")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))
        assert result.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN
        assert result.issue_excluded_detail is not None
        assert "bad input" in result.issue_excluded_detail

    def test_empty_stdout_with_exit_zero_returns_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))
        assert result.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN

    def test_file_not_found_for_node_binary_returns_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        with patch.object(subprocess, "run", side_effect=FileNotFoundError("node not on PATH")):
            gw = _gateway(fake_cli)
            result = gw.preprocess(PreprocessingInput(id="case-01", issue_dir="/tmp/x"))
        assert result.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN
        assert result.issue_excluded_detail is not None
        assert "spawn" in result.issue_excluded_detail.lower()


@pytest.mark.integration
class TestNodeRunnerPreprocessorGatewayIntegration:
    """実際の Node バンドルを呼ぶ。事前に `mise run build-analyzer` 必須。"""

    def setup_method(self) -> None:
        if not CLI_PATH.exists():
            pytest.skip(f"CLI bundle not built: {CLI_PATH}")

    def test_unknown_layout_for_empty_dir(self, tmp_path: Path) -> None:
        # 空ディレクトリは v_*.html も <lib>_* も無いので layout 判定不能
        result = _gateway().preprocess(
            PreprocessingInput(id="empty", issue_dir=str(tmp_path)),
        )
        assert result.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN
        assert result.id == "empty"
