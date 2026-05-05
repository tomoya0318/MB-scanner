"""Node ランナー pruning Gateway のバッチ API テスト (subprocess mocked)"""

import json
from pathlib import Path
import subprocess
from unittest.mock import MagicMock, patch

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


def _fake_node_result(
    id_: str,
    *,
    verdict: str = "pruned",
    effective_timeout_ms: int | None = 5000,
) -> str:
    payload: dict[str, object] = {
        "id": id_,
        "verdict": verdict,
    }
    if effective_timeout_ms is not None:
        payload["effective_timeout_ms"] = effective_timeout_ms
    return json.dumps(payload)


class TestPruneBatchMocked:
    def test_empty_input_returns_empty_list(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        assert gw.prune_batch([]) == []

    def test_missing_bundle_returns_error_per_item(self, tmp_path: Path) -> None:
        gw = _gateway(tmp_path / "nonexistent.js")
        items = [
            PruningInput(id="a", slow="1", fast="1"),
            PruningInput(id="b", slow="1", fast="1"),
        ]
        results = gw.prune_batch(items)
        assert len(results) == 2
        assert all(r.verdict is PruningVerdict.ERROR for r in results)
        assert [r.id for r in results] == ["a", "b"]

    def test_happy_path_with_id_echo(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join(
            [
                _fake_node_result("a"),
                _fake_node_result("b", verdict="initial_mismatch"),
                _fake_node_result("c"),
            ],
        )
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.prune_batch(
                [
                    PruningInput(id="a", slow="1", fast="1"),
                    PruningInput(id="b", slow="1", fast="2"),
                    PruningInput(id="c", slow="3", fast="3"),
                ],
            )

        assert [r.id for r in results] == ["a", "b", "c"]
        assert results[0].verdict is PruningVerdict.PRUNED
        assert results[1].verdict is PruningVerdict.INITIAL_MISMATCH
        assert results[2].verdict is PruningVerdict.PRUNED

    def test_payload_always_includes_timeout_and_max_iterations(self, tmp_path: Path) -> None:
        """送信 JSONL に timeout_ms と max_iterations が必ず含まれることを回帰検証する"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join([_fake_node_result("a"), _fake_node_result("b")])
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")

        captured_input: dict[str, str] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            input_str = kwargs.get("input")
            assert isinstance(input_str, str)
            captured_input["value"] = input_str
            return completed

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            gw.prune_batch(
                [
                    PruningInput(id="a", slow="1", fast="1"),  # デフォルト値が乗る
                    PruningInput(id="b", slow="1", fast="1", timeout_ms=1000, max_iterations=20),
                ],
            )

        lines = [line for line in captured_input["value"].splitlines() if line.strip()]
        assert len(lines) == 2
        parsed = [json.loads(line) for line in lines]
        # デフォルトでも落ちない
        assert parsed[0]["timeout_ms"] == 5000
        assert parsed[0]["max_iterations"] == 1000
        assert parsed[1]["timeout_ms"] == 1000
        assert parsed[1]["max_iterations"] == 20
        assert all("id" in p for p in parsed)

    def test_batch_subprocess_timeout_uses_product_sum(self, tmp_path: Path) -> None:
        """Batch subprocess timeout が sum(timeout_ms × max_iterations) で算出される"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join([_fake_node_result("a"), _fake_node_result("b")])
        captured: dict[str, float] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            timeout = kwargs.get("timeout")
            assert isinstance(timeout, float)
            captured["timeout"] = timeout
            return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            gw.prune_batch(
                [
                    PruningInput(id="a", slow="1", fast="1", timeout_ms=1000, max_iterations=5),
                    PruningInput(id="b", slow="1", fast="1", timeout_ms=2000, max_iterations=3),
                ],
            )

        # (1000*5 + 2000*3) / 1000 = 5 + 6 = 11s
        # + buffer 30s + margin 5s = 46s
        assert captured["timeout"] == pytest.approx(46.0)

    def test_subprocess_timeout_becomes_error_per_item(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        with patch.object(
            subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="node", timeout=30),
        ):
            gw = _gateway(fake_cli)
            results = gw.prune_batch(
                [
                    PruningInput(id="a", slow="1", fast="1"),
                    PruningInput(id="b", slow="1", fast="1"),
                ],
            )
        assert [r.verdict for r in results] == [PruningVerdict.ERROR, PruningVerdict.ERROR]
        assert all(r.error_message is not None and "batch subprocess timeout" in r.error_message for r in results)

    def test_nonzero_exit_becomes_error_per_item(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="boom")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.prune_batch(
                [PruningInput(id="a", slow="1", fast="1")],
            )
        assert results[0].verdict is PruningVerdict.ERROR
        assert results[0].error_message is not None
        assert "exited with code 2" in results[0].error_message

    def test_missing_result_lines_are_filled_with_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        # a の結果だけ返して b は落ちた (途中クラッシュ想定)
        stdout = _fake_node_result("a")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.prune_batch(
                [
                    PruningInput(id="a", slow="1", fast="1"),
                    PruningInput(id="b", slow="1", fast="1"),
                ],
            )
        assert results[0].id == "a"
        assert results[0].verdict is PruningVerdict.PRUNED
        assert results[1].id == "b"
        assert results[1].verdict is PruningVerdict.ERROR
        assert results[1].error_message is not None
        assert "did not return a result" in results[1].error_message

    def test_missing_id_input_is_preserved_as_none(self, tmp_path: Path) -> None:
        """入力に id が無ければ出力にも id を残さない (単発呼び出し互換)

        Gateway が内部ランダムキーを詰めるので、subprocess mock の input を
        読み取って実際に使われたキーをエコーバックする。
        """
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        captured: dict[str, str] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            input_str = kwargs.get("input")
            assert isinstance(input_str, str)
            sent = json.loads(input_str.splitlines()[0])
            internal_key = sent["id"]
            captured["key"] = internal_key
            return subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=_fake_node_result(internal_key),
                stderr="",
            )

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            results = gw.prune_batch([PruningInput(slow="1", fast="1")])
        assert captured["key"].startswith("__mb_prune_batch_idx__")
        assert results[0].id is None
        assert results[0].verdict is PruningVerdict.PRUNED

    def test_reserved_prefix_in_user_id_raises(self, tmp_path: Path) -> None:
        """ユーザー指定の id が内部プレフィックスと衝突する場合は早期エラー"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        with pytest.raises(ValueError, match="reserved prefix"):
            gw.prune_batch([PruningInput(id="__mb_prune_batch_idx__evil", slow="1", fast="1")])

    def test_effective_timeout_ms_mismatch_is_warned(self, tmp_path: Path) -> None:
        """Node が異なる timeout_ms で実行していた場合に警告を error_message に注入する"""
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = _fake_node_result("a", effective_timeout_ms=5000)
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.prune_batch(
                [PruningInput(id="a", slow="1", fast="1", timeout_ms=1000)],
            )
        assert results[0].error_message is not None
        assert "timeout_ms mismatch" in results[0].error_message
        assert "requested 1000" in results[0].error_message
        assert "Node used 5000" in results[0].error_message


class TestPruneBatchProtocolConformance:
    """Port Protocol 的に prune + prune_batch が揃っていることの型整合テスト"""

    def test_prune_batch_is_callable(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        assert callable(gw.prune_batch)
        # 空呼び出しは subprocess を起動しないこと
        with patch.object(subprocess, "run", new=MagicMock()) as run_mock:
            gw.prune_batch([])
            assert run_mock.call_count == 0
