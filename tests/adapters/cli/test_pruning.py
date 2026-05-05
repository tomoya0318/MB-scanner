"""prune CLI のテスト（Gateway をモックした CliRunner）"""

from collections.abc import Sequence
import json
from pathlib import Path
import threading
import time
from unittest.mock import patch

from typer.testing import CliRunner

from mb_scanner.adapters.cli import app
from mb_scanner.domain.entities.pruning import (
    PruningInput,
    PruningResult,
    PruningVerdict,
)


def _stub_result(verdict: PruningVerdict = PruningVerdict.PRUNED) -> PruningResult:
    return PruningResult(verdict=verdict)


GATEWAY_CLS = "mb_scanner.adapters.cli.pruning.NodeRunnerPrunerGateway"


class TestPruneCLI:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_with_inline_flags_pruned(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.PRUNED)
            res = self.runner.invoke(app, ["prune", "--slow", "1+1", "--fast", "2"])
        assert res.exit_code == 0
        payload = json.loads(res.stdout)
        assert payload["verdict"] == "pruned"

    def test_initial_mismatch_exit_code_1(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.INITIAL_MISMATCH)
            res = self.runner.invoke(app, ["prune", "--slow", "1", "--fast", "2"])
        assert res.exit_code == 1

    def test_error_exit_code_2(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.ERROR)
            res = self.runner.invoke(app, ["prune", "--slow", "1", "--fast", "1"])
        assert res.exit_code == 2

    def test_missing_slow_fast_without_input_is_error(self) -> None:
        res = self.runner.invoke(app, ["prune"])
        assert res.exit_code != 0
        assert "--input" in res.stdout or "--input" in res.stderr or "--input" in (res.output or "")

    def test_with_input_file(self, tmp_path: Path) -> None:
        input_file = tmp_path / "trip.json"
        input_file.write_text(json.dumps({"setup": "const x = 1;", "slow": "x", "fast": "x"}))
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.PRUNED)
            res = self.runner.invoke(app, ["prune", "--input", str(input_file)])
        assert res.exit_code == 0
        call_input = gw_cls.return_value.prune.call_args.args[0]
        assert call_input.setup == "const x = 1;"
        assert call_input.slow == "x"
        assert call_input.fast == "x"

    def test_max_iterations_passed_to_gateway(self) -> None:
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.PRUNED)
            self.runner.invoke(
                app,
                ["prune", "--slow", "1", "--fast", "1", "--max-iterations", "30"],
            )
        call_input = gw_cls.return_value.prune.call_args.args[0]
        assert call_input.max_iterations == 30

    def test_output_to_file(self, tmp_path: Path) -> None:
        out = tmp_path / "result.json"
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.PRUNED)
            res = self.runner.invoke(
                app,
                ["prune", "--slow", "1", "--fast", "1", "--output", str(out)],
            )
        assert res.exit_code == 0
        written = json.loads(out.read_text())
        assert written["verdict"] == "pruned"

    def test_inline_flags_override_input_file(self, tmp_path: Path) -> None:
        input_file = tmp_path / "trip.json"
        input_file.write_text(json.dumps({"setup": "var a = 1;", "slow": "a", "fast": "a"}))
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune.return_value = _stub_result(PruningVerdict.PRUNED)
            self.runner.invoke(
                app,
                [
                    "prune",
                    "--input",
                    str(input_file),
                    "--slow",
                    "1",
                    "--fast",
                    "2",
                ],
            )
        call_input = gw_cls.return_value.prune.call_args.args[0]
        assert call_input.slow == "1"
        assert call_input.fast == "2"
        assert call_input.setup == "var a = 1;"  # setup は file のまま

    def test_invalid_json_input(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.json"
        bad.write_text("not json")
        res = self.runner.invoke(app, ["prune", "--input", str(bad)])
        assert res.exit_code == 2

    def test_input_file_not_found_exits_2(self, tmp_path: Path) -> None:
        missing = tmp_path / "nope.json"
        res = self.runner.invoke(app, ["prune", "--input", str(missing)])
        assert res.exit_code == 2


def _stub_batch_result(input_id: str, verdict: PruningVerdict = PruningVerdict.PRUNED) -> PruningResult:
    return PruningResult(id=input_id, verdict=verdict)


class TestPruneBatchCLI:
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
                {"id": "a", "slow": "1", "fast": "1"},
                {"id": "b", "slow": "1", "fast": "2"},
                {"id": "c", "slow": "3", "fast": "3"},
            ],
        )
        output_path = tmp_path / "results.jsonl"

        def fake_prune_batch(items: Sequence[PruningInput]) -> list[PruningResult]:
            return [
                _stub_batch_result(
                    item.id or "?",
                    PruningVerdict.PRUNED if item.slow == item.fast else PruningVerdict.INITIAL_MISMATCH,
                )
                for item in items
            ]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune_batch.side_effect = fake_prune_batch
            res = self.runner.invoke(
                app,
                [
                    "prune-batch",
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
        assert [w["verdict"] for w in written] == ["pruned", "initial_mismatch", "pruned"]

    def test_parallel_preserves_input_order(self, tmp_path: Path) -> None:
        """7 件を --workers 2 --batch-size 3 で並列実行して入力順が保たれることを検証

        Gateway モックに人為的な遅延を入れて、完了順序が入力順とずれる状況を作っても、
        CLI 側の `_run_batch` が `batch_results: dict[int, ...]` で入力順に再構成
        してくれることを確認する。
        """
        input_path = self._write_jsonl(
            tmp_path,
            [{"id": f"item-{i}", "slow": "1", "fast": "1"} for i in range(7)],
        )
        output_path = tmp_path / "results.jsonl"

        # batch_size=3 なので 3 chunks (3, 3, 1) になる。
        # 各 chunk に異なる遅延を入れて完了順をシャッフル: 最初の chunk が一番遅い。
        chunk_call_count = 0
        chunk_lock = threading.Lock()

        def slow_first_prune_batch(items: Sequence[PruningInput]) -> list[PruningResult]:
            nonlocal chunk_call_count
            with chunk_lock:
                chunk_call_count += 1
                this_chunk = chunk_call_count
            # 1 番目の chunk を遅延させる (3 番目より遅く完了させる)
            if this_chunk == 1:
                time.sleep(0.2)
            elif this_chunk == 2:
                time.sleep(0.1)
            return [_stub_batch_result(item.id or "?") for item in items]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune_batch.side_effect = slow_first_prune_batch
            res = self.runner.invoke(
                app,
                [
                    "prune-batch",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                    "--workers",
                    "2",
                    "--batch-size",
                    "3",
                ],
            )

        assert res.exit_code == 0, res.stdout + res.stderr
        written = [json.loads(line) for line in output_path.read_text().splitlines()]
        # 完了順に依らず入力順 (item-0, item-1, ..., item-6) を維持
        assert [w["id"] for w in written] == [f"item-{i}" for i in range(7)]

    def test_workers_minus_one_resolves(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [{"id": "a", "slow": "1", "fast": "1"}],
        )
        with patch(GATEWAY_CLS) as gw_cls, patch("os.cpu_count", return_value=4):
            gw_cls.return_value.prune_batch.return_value = [_stub_batch_result("a")]
            res = self.runner.invoke(
                app,
                [
                    "prune-batch",
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
        res = self.runner.invoke(app, ["prune-batch", "--input", str(path)])
        assert res.exit_code == 2

    def test_stdout_output_when_no_output_path(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [{"id": "a", "slow": "1", "fast": "1"}],
        )
        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune_batch.return_value = [_stub_batch_result("a")]
            res = self.runner.invoke(
                app,
                ["prune-batch", "--input", str(input_path)],
            )
        assert res.exit_code == 0
        # stdout に JSONL が出力されることを確認
        lines = [line for line in res.stdout.splitlines() if line.strip()]
        assert len(lines) == 1
        written = json.loads(lines[0])
        assert written["id"] == "a"
        assert written["verdict"] == "pruned"

    def test_timeout_and_max_iterations_precedence_jsonl_over_cli_default(self, tmp_path: Path) -> None:
        """JSONL 行に値があれば優先、無ければ CLI デフォルトで補完"""
        input_path = self._write_jsonl(
            tmp_path,
            [
                {"id": "a", "slow": "1", "fast": "1", "timeout_ms": 1500, "max_iterations": 25},
                {"id": "b", "slow": "1", "fast": "1"},  # 両方なし
            ],
        )
        captured: list[PruningInput] = []

        def fake_prune_batch(items: Sequence[PruningInput]) -> list[PruningResult]:
            captured.extend(items)
            return [_stub_batch_result(item.id or "?") for item in items]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune_batch.side_effect = fake_prune_batch
            res = self.runner.invoke(
                app,
                [
                    "prune-batch",
                    "--input",
                    str(input_path),
                    "--timeout-ms",
                    "9000",
                    "--max-iterations",
                    "100",
                    "--workers",
                    "1",
                ],
            )
        assert res.exit_code == 0, res.stdout + res.stderr
        by_id = {item.id: item for item in captured}
        assert by_id["a"].timeout_ms == 1500  # JSONL 優先
        assert by_id["a"].max_iterations == 25  # JSONL 優先
        assert by_id["b"].timeout_ms == 9000  # CLI デフォルトで補完
        assert by_id["b"].max_iterations == 100  # CLI デフォルトで補完

    def test_empty_input_yields_empty_output_and_exit_0(self, tmp_path: Path) -> None:
        input_path = tmp_path / "empty.jsonl"
        input_path.write_text("")
        output_path = tmp_path / "results.jsonl"

        with patch(GATEWAY_CLS):
            res = self.runner.invoke(
                app,
                [
                    "prune-batch",
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
        res = self.runner.invoke(app, ["prune-batch", "--input", str(missing)])
        assert res.exit_code == 2

    def test_id_auto_filled_when_missing_in_jsonl(self, tmp_path: Path) -> None:
        input_path = self._write_jsonl(
            tmp_path,
            [{"slow": "1", "fast": "1"}, {"slow": "2", "fast": "2"}],
        )
        captured: list[PruningInput] = []

        def fake_prune_batch(items: Sequence[PruningInput]) -> list[PruningResult]:
            captured.extend(items)
            return [_stub_batch_result(item.id or "?") for item in items]

        with patch(GATEWAY_CLS) as gw_cls:
            gw_cls.return_value.prune_batch.side_effect = fake_prune_batch
            res = self.runner.invoke(
                app,
                ["prune-batch", "--input", str(input_path), "--workers", "1"],
            )
        assert res.exit_code == 0, res.stdout + res.stderr
        assert [item.id for item in captured] == ["line-0001", "line-0002"]
