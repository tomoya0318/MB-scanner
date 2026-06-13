"""check-equivalence CLI のテスト（Gateway をモックした CliRunner）"""

from collections.abc import Sequence
import json
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from mb_scanner.cli import app
from mb_scanner.equivalence.models import (
    EquivalenceCheckResult,
    EquivalenceInput,
    Oracle,
    OracleObservation,
    OracleVerdict,
    Verdict,
)


def _observations_for(verdict: Verdict) -> list[OracleObservation]:
    """Use case が observation から verdict を再計算するため、整合する observation を組む。

    INCONCLUSIVE は「全 oracle が not_applicable」(= 観測チャネルゼロ) で表現する。
    """
    if verdict is Verdict.INCONCLUSIVE:
        return_value = OracleVerdict.NOT_APPLICABLE
    else:
        return_value = {
            Verdict.EQUAL: OracleVerdict.EQUAL,
            Verdict.NOT_EQUAL: OracleVerdict.NOT_EQUAL,
            Verdict.ERROR: OracleVerdict.ERROR,
        }[verdict]
    return [
        OracleObservation(oracle=Oracle.RETURN_VALUE, verdict=return_value),
        OracleObservation(oracle=Oracle.ARGUMENT_MUTATION, verdict=OracleVerdict.NOT_APPLICABLE),
        OracleObservation(oracle=Oracle.EXCEPTION, verdict=OracleVerdict.NOT_APPLICABLE),
        OracleObservation(oracle=Oracle.EXTERNAL_OBSERVATION, verdict=OracleVerdict.NOT_APPLICABLE),
    ]


def _stub_result(verdict: Verdict = Verdict.EQUAL) -> EquivalenceCheckResult:
    return EquivalenceCheckResult(verdict=verdict, observations=_observations_for(verdict))


GATEWAY_CLS = "mb_scanner.equivalence.cli.NodeRunnerEquivalenceGateway"


class TestCheckEquivalenceCLI:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_with_inline_flags_equal(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.EQUAL)
            res = self.runner.invoke(app, ["check-equivalence", "--before", "1", "--after", "1"])
        assert res.exit_code == 0
        payload = json.loads(res.stdout)
        assert payload["verdict"] == "equal"

    def test_not_equal_exit_code_1(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.NOT_EQUAL)
            res = self.runner.invoke(app, ["check-equivalence", "--before", "1", "--after", "2"])
        assert res.exit_code == 1

    def test_inconclusive_exit_code_2(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.INCONCLUSIVE)
            res = self.runner.invoke(app, ["check-equivalence", "--before", "1", "--after", "1"])
        assert res.exit_code == 2
        payload = json.loads(res.stdout)
        assert payload["verdict"] == "inconclusive"
        assert payload["verdict_reason"] == "no-observable-channel"

    def test_error_exit_code_3(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.ERROR)
            res = self.runner.invoke(app, ["check-equivalence", "--before", "1", "--after", "1"])
        assert res.exit_code == 3

    def test_missing_before_after_without_input_is_error(self) -> None:
        res = self.runner.invoke(app, ["check-equivalence"])
        assert res.exit_code != 0
        assert "--input" in res.stdout or "--input" in res.stderr or "--input" in (res.output or "")

    def test_with_input_file(self, tmp_path: Path) -> None:
        input_file = tmp_path / "trip.json"
        input_file.write_text(json.dumps({"setup": "const x = 1;", "before": "x", "after": "x"}))
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.EQUAL)
            res = self.runner.invoke(app, ["check-equivalence", "--input", str(input_file)])
        assert res.exit_code == 0
        call_input = gw_cls.return_value.check.call_args.args[0]
        assert call_input.setup == "const x = 1;"
        assert call_input.before == "x"
        assert call_input.after == "x"

    def test_output_to_file(self, tmp_path: Path) -> None:
        out = tmp_path / "result.json"
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.EQUAL)
            res = self.runner.invoke(
                app,
                ["check-equivalence", "--before", "1", "--after", "1", "--output", str(out)],
            )
        assert res.exit_code == 0
        written = json.loads(out.read_text())
        assert written["verdict"] == "equal"

    def test_inline_flags_override_input_file(self, tmp_path: Path) -> None:
        input_file = tmp_path / "trip.json"
        input_file.write_text(json.dumps({"setup": "var a = 1;", "before": "a", "after": "a"}))
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check.return_value = _stub_result(Verdict.EQUAL)
            self.runner.invoke(
                app,
                [
                    "check-equivalence",
                    "--input",
                    str(input_file),
                    "--before",
                    "1",
                    "--after",
                    "2",
                ],
            )
        call_input = gw_cls.return_value.check.call_args.args[0]
        assert call_input.before == "1"
        assert call_input.after == "2"
        assert call_input.setup == "var a = 1;"  # setup は file のまま

    def test_invalid_json_input(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.json"
        bad.write_text("not json")
        res = self.runner.invoke(app, ["check-equivalence", "--input", str(bad)])
        assert res.exit_code == 3


def _stub_batch_result(input_id: str, verdict: Verdict = Verdict.EQUAL) -> EquivalenceCheckResult:
    """Batch API 向けの stub 結果 (id と observation を整合させる)"""
    return EquivalenceCheckResult(id=input_id, verdict=verdict, observations=_observations_for(verdict))


class TestCheckEquivalenceBatchCLI:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def _write_jsonl(self, tmp_path: Path, lines: list[dict[str, object]]) -> Path:
        path = tmp_path / "trips.jsonl"
        path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
        return path

    def test_happy_path_with_workers_2(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [
                {"id": "a", "before": "1", "after": "1"},
                {"id": "b", "before": "1", "after": "2"},
                {"id": "c", "before": "3", "after": "3"},
            ],
        )
        output_path = tmp_path / "results.jsonl"

        def fake_check_batch(items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
            return [
                _stub_batch_result(item.id or "?", Verdict.EQUAL if item.before == item.after else Verdict.NOT_EQUAL)
                for item in items
            ]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check_batch.side_effect = fake_check_batch
            res = self.runner.invoke(
                app,
                [
                    "check-equivalence-batch",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                    "--workers",
                    "2",
                ],
            )

        assert res.exit_code == 0, res.stdout + res.stderr
        written = [json.loads(line) for line in output_path.read_text().splitlines()]
        assert [w["id"] for w in written] == ["a", "b", "c"]
        assert [w["verdict"] for w in written] == ["equal", "not_equal", "equal"]

    def test_workers_minus_one_resolves(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [{"id": "a", "before": "1", "after": "1"}],
        )
        with patch(GATEWAY_CLS) as gw_cls, patch("os.cpu_count", return_value=4):
            gw_cls.return_value.check_batch.return_value = [_stub_batch_result("a")]
            res = self.runner.invoke(
                app,
                [
                    "check-equivalence-batch",
                    "--input",
                    str(input_path),
                    "--workers",
                    "-1",
                ],
            )
        assert res.exit_code == 0, res.stdout + res.stderr

    def test_jsonl_parse_failure_exits_2(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.jsonl"
        path.write_text("not json\n")
        res = self.runner.invoke(app, ["check-equivalence-batch", "--input", str(path)])
        assert res.exit_code == 2

    def test_stdout_output_when_no_output_path(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [{"id": "a", "before": "1", "after": "1"}],
        )
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check_batch.return_value = [_stub_batch_result("a")]
            res = self.runner.invoke(
                app,
                ["check-equivalence-batch", "--input", str(input_path)],
            )
        assert res.exit_code == 0
        # stdout に JSONL が出力されることを確認
        lines = [line for line in res.stdout.splitlines() if line.strip()]
        assert len(lines) == 1
        written = json.loads(lines[0])
        assert written["id"] == "a"
        assert written["verdict"] == "equal"

    def test_timeout_ms_precedence_jsonl_over_cli_default(self, tmp_path: Path) -> None:
        """JSONL 行に timeout_ms があれば優先、無ければ CLI デフォルトで補完"""
        input_path = self._write_jsonl(
            tmp_path,
            [
                {"id": "a", "before": "1", "after": "1", "timeout_ms": 1500},
                {"id": "b", "before": "1", "after": "1"},  # timeout_ms なし
            ],
        )
        captured: list[EquivalenceInput] = []

        def fake_check_batch(items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
            captured.extend(items)
            return [_stub_batch_result(item.id or "?") for item in items]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check_batch.side_effect = fake_check_batch
            res = self.runner.invoke(
                app,
                [
                    "check-equivalence-batch",
                    "--input",
                    str(input_path),
                    "--timeout-ms",
                    "9000",
                    "--workers",
                    "1",
                ],
            )
        assert res.exit_code == 0, res.stdout + res.stderr
        by_id = {item.id: item for item in captured}
        assert by_id["a"].timeout_ms == 1500  # JSONL 優先
        assert by_id["b"].timeout_ms == 9000  # CLI デフォルトで補完

    def test_empty_input_yields_empty_output_and_exit_0(self, tmp_path: Path) -> None:
        input_path = tmp_path / "empty.jsonl"
        input_path.write_text("")
        output_path = tmp_path / "results.jsonl"

        with patch(GATEWAY_CLS):
            res = self.runner.invoke(
                app,
                [
                    "check-equivalence-batch",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                ],
            )
        assert res.exit_code == 0
        assert output_path.read_text() == ""

    def test_input_file_not_found_exits_2(self, tmp_path: Path) -> None:
        missing = tmp_path / "nope.jsonl"
        res = self.runner.invoke(app, ["check-equivalence-batch", "--input", str(missing)])
        assert res.exit_code == 2

    def test_id_auto_filled_when_missing_in_jsonl(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [{"before": "1", "after": "1"}, {"before": "2", "after": "2"}],
        )
        captured: list[EquivalenceInput] = []

        def fake_check_batch(items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
            captured.extend(items)
            return [_stub_batch_result(item.id or "?") for item in items]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.check_batch.side_effect = fake_check_batch
            res = self.runner.invoke(
                app,
                ["check-equivalence-batch", "--input", str(input_path), "--workers", "1"],
            )
        assert res.exit_code == 0, res.stdout + res.stderr
        assert [item.id for item in captured] == ["line-0001", "line-0002"]
