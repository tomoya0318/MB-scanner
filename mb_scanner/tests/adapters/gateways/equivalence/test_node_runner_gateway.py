"""Node ランナー Gateway のテスト

- 単体テスト: subprocess をモックして JSON 往復・エラー経路をカバー
- integration test (`-m integration`): 実際に mb-analyzer/dist/cli.js を呼ぶ
"""

import json
from pathlib import Path
import subprocess
from unittest.mock import patch

import pytest

from mb_scanner.adapters.gateways.equivalence.node_runner_gateway import (
    NodeRunnerEquivalenceGateway,
)
from mb_scanner.domain.entities.equivalence import (
    EquivalenceInput,
    Oracle,
    OracleVerdict,
    Verdict,
)

PROJECT_ROOT = Path(__file__).resolve().parents[4]
CLI_PATH = PROJECT_ROOT / "mb-analyzer" / "dist" / "cli.js"


def _gateway(cli_path: Path | None = None) -> NodeRunnerEquivalenceGateway:
    return NodeRunnerEquivalenceGateway(cli_path or CLI_PATH)


class TestNodeRunnerGatewayMocked:
    def test_returns_error_when_bundle_missing(self, tmp_path: Path) -> None:
        gw = _gateway(tmp_path / "nonexistent.js")
        result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.error_message is not None
        assert "not found" in result.error_message

    def test_parses_stdout_into_domain_model(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps(
            {
                "verdict": "equal",
                "observations": [
                    {
                        "oracle": "return_value",
                        "verdict": "equal",
                        "before_value": "2",
                        "after_value": "2",
                    },
                    {"oracle": "argument_mutation", "verdict": "not_applicable"},
                    {"oracle": "exception", "verdict": "not_applicable"},
                    {"oracle": "external_observation", "verdict": "not_applicable"},
                ],
            }
        )
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed) as run_mock:
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1+1", after="2"))

        assert result.verdict is Verdict.EQUAL
        assert result.observations[0].oracle is Oracle.RETURN_VALUE
        assert result.observations[0].verdict is OracleVerdict.EQUAL
        assert run_mock.call_count == 1

    def test_subprocess_timeout_becomes_error_verdict(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        with patch.object(
            subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="node", timeout=5),
        ):
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.error_message is not None
        assert "timeout" in result.error_message.lower()

    def test_nonzero_exit_with_empty_stdout_is_error(self, tmp_path: Path) -> None:
        """Stdout が空なら exit=2 でも subprocess 失敗扱い"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="bad input")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.error_message is not None
        assert "bad input" in result.error_message

    def test_exit_2_with_inconclusive_json_preserves_verdict(self, tmp_path: Path) -> None:
        """Node が exit=2 (inconclusive) を返した場合、verdict と verdict_reason を保持する"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps(
            {
                "verdict": "inconclusive",
                "observations": [],
                "verdict_reason": "no-positive-evidence",
            },
        )
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.INCONCLUSIVE
        assert result.verdict_reason == "no-positive-evidence"

    def test_exit_3_with_error_json_preserves_error_message(self, tmp_path: Path) -> None:
        """Node が exit=3 (error) で error verdict JSON を返した場合の情報保持

        error_message と verdict_reason (setup-failure 等の throw phase 分類) を
        汎用メッセージで潰さず保持する。
        """
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout_payload = json.dumps(
            {
                "verdict": "error",
                "observations": [],
                "verdict_reason": "setup-failure",
                "error_message": "setup code threw: ReferenceError",
            },
        )
        completed = subprocess.CompletedProcess(args=[], returncode=3, stdout=stdout_payload, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.verdict_reason == "setup-failure"
        assert result.error_message == "setup code threw: ReferenceError"

    def test_unexpected_exit_code_is_error(self, tmp_path: Path) -> None:
        """0/1/2/3 以外の exit code (例: SIGSEGV=139) は握りつぶさず error 扱い"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=139, stdout="", stderr="killed")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.error_message is not None
        assert "139" in result.error_message

    def test_invalid_json_stdout_is_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="not json", stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            result = gw.check(EquivalenceInput(before="1", after="1"))
        assert result.verdict is Verdict.ERROR
        assert result.error_message is not None
        assert "JSON" in result.error_message


@pytest.mark.integration
class TestNodeRunnerGatewayIntegration:
    """実際の Node バンドルを呼ぶ。事前に `pnpm --prefix mb-analyzer build` 必須。"""

    def setup_method(self) -> None:
        if not CLI_PATH.exists():
            pytest.skip(f"CLI bundle not built: {CLI_PATH}")

    def test_equal_verdict(self) -> None:
        result = _gateway().check(EquivalenceInput(before="1 + 1", after="2"))
        assert result.verdict is Verdict.EQUAL

    def test_not_equal_verdict_on_selakovic_8_negative(self) -> None:
        result = _gateway().check(
            EquivalenceInput(setup="const x = -3;", before="x % 2", after="x & 1"),
        )
        assert result.verdict is Verdict.NOT_EQUAL

    def test_timeout_is_not_equal(self) -> None:
        result = _gateway().check(
            EquivalenceInput(before="while(true){}", after="1", timeout_ms=50),
        )
        # 片方 timeout 例外、片方正常 → O3 で not_equal
        assert result.verdict is Verdict.NOT_EQUAL
