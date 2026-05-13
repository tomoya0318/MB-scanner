"""Node ランナー pruning Gateway のテスト

- 単体テスト: subprocess をモックして JSON 往復・エラー経路をカバー
- integration test (`-m integration`): 実際に mb-analyzer/dist/cli.js を呼ぶ
"""

import json
from pathlib import Path
import subprocess
from unittest.mock import patch

import pytest

from mb_scanner.adapters.gateways.pruning.node_runner_gateway import (
    NodeRunnerPrunerGateway,
)
from mb_scanner.domain.entities.pruning import (
    PruningInput,
    PruningVerdict,
)

PROJECT_ROOT = Path(__file__).resolve().parents[4]
CLI_PATH = PROJECT_ROOT / "mb-analyzer" / "dist" / "cli.js"


def _gateway(cli_path: Path | None = None) -> NodeRunnerPrunerGateway:
    return NodeRunnerPrunerGateway(cli_path or CLI_PATH)


class TestNodeRunnerPrunerGatewayMocked:
    def test_returns_error_when_bundle_missing(self, tmp_path: Path) -> None:
        gw = _gateway(tmp_path / "nonexistent.js")
        result = gw.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message is not None
        assert "not found" in result.error_message

    def test_parses_stdout_into_domain_model(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps(
            {
                "verdict": "pruned",
                "pattern_code": "2",
                "placeholders": [],
                "iterations": 1,
            },
        )
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed) as run_mock:
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1+1", fast="2"))

        assert result.verdict is PruningVerdict.PRUNED
        assert result.pattern_code == "2"
        assert result.iterations == 1
        assert run_mock.call_count == 1

    def test_subprocess_invoked_with_prune_subcommand(self, tmp_path: Path) -> None:
        """`node dist/cli.js prune` が呼ばれることを引数レベルで検証"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps({"verdict": "pruned"})
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed) as run_mock:
            gw = _gateway(fake_cli)
            gw.prune(PruningInput(slow="1", fast="1"))

        call_args = run_mock.call_args
        cmd = call_args.args[0]
        assert cmd[-1] == "prune"
        assert str(fake_cli) in cmd

    def test_subprocess_timeout_uses_timeout_ms_times_max_iterations(self, tmp_path: Path) -> None:
        """Subprocess timeout が timeout_ms × max_iterations + margin で算出される"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        captured: dict[str, float] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            timeout = kwargs.get("timeout")
            assert isinstance(timeout, float)
            captured["timeout"] = timeout
            return subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps({"verdict": "pruned"}),
                stderr="",
            )

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            gw.prune(
                PruningInput(slow="1", fast="1", timeout_ms=1000, max_iterations=10),
            )

        # timeout_ms=1000 × max_iterations=10 = 10s + margin 5s = 15s
        assert captured["timeout"] == pytest.approx(15.0)

    def test_subprocess_timeout_becomes_error_verdict(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        with patch.object(
            subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="node", timeout=5),
        ):
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message is not None
        assert "timeout" in result.error_message.lower()

    def test_nonzero_exit_with_empty_stdout_is_error(self, tmp_path: Path) -> None:
        """Stdout が空なら exit=2 でも subprocess 失敗扱い"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="bad input")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message is not None
        assert "bad input" in result.error_message

    def test_exit_2_with_error_json_preserves_error_message(self, tmp_path: Path) -> None:
        """Node が exit=2 で error verdict JSON を返した場合、error_message を保持する"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps(
            {
                "verdict": "error",
                "error_message": "parse failed: SyntaxError",
            },
        )
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message == "parse failed: SyntaxError"

    def test_initial_mismatch_verdict_passthrough(self, tmp_path: Path) -> None:
        """exit=1 (initial_mismatch) の verdict が正しく転送される"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps({"verdict": "initial_mismatch"})
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1", fast="2"))
        assert result.verdict is PruningVerdict.INITIAL_MISMATCH

    def test_unexpected_exit_code_is_error(self, tmp_path: Path) -> None:
        """0/1/2 以外の exit code (例: SIGSEGV=139) は握りつぶさず error 扱い"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=139, stdout="", stderr="killed")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message is not None
        assert "139" in result.error_message

    def test_invalid_json_stdout_is_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="not json", stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.prune(PruningInput(slow="1", fast="1"))
        assert result.verdict is PruningVerdict.ERROR
        assert result.error_message is not None
        assert "JSON" in result.error_message


@pytest.mark.integration
class TestNodeRunnerPrunerGatewayIntegration:
    """実際の Node バンドルを呼ぶ。事前に `mise run build-analyzer` 必須。"""

    def setup_method(self) -> None:
        if not CLI_PATH.exists():
            pytest.skip(f"CLI bundle not built: {CLI_PATH}")

    def test_pruned_verdict(self) -> None:
        result = _gateway().prune(
            PruningInput(slow="1 + 1", fast="2", timeout_ms=1000, max_iterations=10),
        )
        assert result.verdict is PruningVerdict.PRUNED

    def test_initial_mismatch_verdict(self) -> None:
        result = _gateway().prune(
            PruningInput(slow="1", fast="2", timeout_ms=1000, max_iterations=10),
        )
        assert result.verdict is PruningVerdict.INITIAL_MISMATCH
