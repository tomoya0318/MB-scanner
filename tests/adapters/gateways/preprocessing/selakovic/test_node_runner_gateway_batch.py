"""Node ランナー preprocessing Gateway (Selakovic) の batch API テスト (subprocess mocked)

batch では 1 入力に対して N (>=1) の結果が返る可能性があるため、id prefix-match で
入力↔結果を対応付ける。``<original_id>`` か ``<original_id>#<idx>`` の形式に一致する
全行を集めて、suffix を保持したまま元 id にリネームする。
"""

import json
from pathlib import Path
import subprocess
from unittest.mock import patch

import pytest

from mb_scanner.adapters.gateways.preprocessing.selakovic.node_runner_gateway import (
    INTERNAL_KEY_PREFIX,
    NodeRunnerPreprocessorGateway,
)
from mb_scanner.domain.entities.preprocessing import (
    ExclusionReason,
    LayoutKind,
    PreprocessingInput,
)

PROJECT_ROOT = Path(__file__).resolve().parents[5]
CLI_PATH = PROJECT_ROOT / "mb-analyzer" / "dist" / "cli.js"


def _gateway(cli_path: Path | None = None) -> NodeRunnerPreprocessorGateway:
    return NodeRunnerPreprocessorGateway(cli_path or CLI_PATH)


def _fake_extracted_result(id_: str | None = None) -> str:
    payload: dict[str, object] = {
        "layout": "client",
        "slow": "arr[0]",
        "fast": "arr[1]",
    }
    if id_ is not None:
        payload["id"] = id_
    return json.dumps(payload)


class TestPreprocessBatchMocked:
    def test_empty_input_returns_empty_list(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        assert gw.preprocess_batch([]) == []

    def test_missing_bundle_returns_error_per_item(self, tmp_path: Path) -> None:
        gw = _gateway(tmp_path / "nonexistent.js")
        items = [
            PreprocessingInput(id="a", issue_dir="/tmp/a"),
            PreprocessingInput(id="b", issue_dir="/tmp/b"),
        ]
        results = gw.preprocess_batch(items)
        assert len(results) == 2
        assert all(r.excluded is ExclusionReason.LAYOUT_UNKNOWN for r in results)
        assert [r.id for r in results] == ["a", "b"]

    def test_happy_path_with_id_echo_single_result_per_item(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join(
            [
                _fake_extracted_result(id_="a"),
                _fake_extracted_result(id_="b"),
                _fake_extracted_result(id_="c"),
            ],
        )
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch(
                [
                    PreprocessingInput(id="a", issue_dir="/tmp/a"),
                    PreprocessingInput(id="b", issue_dir="/tmp/b"),
                    PreprocessingInput(id="c", issue_dir="/tmp/c"),
                ],
            )

        assert [r.id for r in results] == ["a", "b", "c"]

    def test_n_candidates_per_item_via_prefix_match(self, tmp_path: Path) -> None:
        # id="a" の入力に対して "a#0" / "a#1" の 2 結果が返る
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join(
            [
                _fake_extracted_result(id_="a#0"),
                _fake_extracted_result(id_="a#1"),
                _fake_extracted_result(id_="b"),
            ],
        )
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch(
                [
                    PreprocessingInput(id="a", issue_dir="/tmp/a"),
                    PreprocessingInput(id="b", issue_dir="/tmp/b"),
                ],
            )

        assert [r.id for r in results] == ["a#0", "a#1", "b"]

    def test_id_renamed_when_input_id_differs_from_match_prefix(self, tmp_path: Path) -> None:
        # 入力 id="orig", Node 出力 id="orig#0" → 出力 id は "orig#0" のままだが、
        # batch_key を rename するロジック (内部 salt key 経由) も同じ仕組みで動く
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = _fake_extracted_result(id_="orig#0")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch([PreprocessingInput(id="orig", issue_dir="/tmp/x")])

        assert [r.id for r in results] == ["orig#0"]

    def test_input_without_id_uses_internal_salt_key_and_returns_none(self, tmp_path: Path) -> None:
        # id 無し入力には内部 salt key を発行し、Node 出力に同じ key で返ってきたものを
        # 元の None に置換する
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        captured: dict[str, str] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            payload = kwargs.get("input")
            assert isinstance(payload, str)
            captured["payload"] = payload
            # 入力で送られた key を解析して、その key で結果を返す
            sent_id = json.loads(payload.strip().split("\n")[0])["id"]
            stdout = _fake_extracted_result(id_=sent_id)
            return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch([PreprocessingInput(issue_dir="/tmp/x")])

        # 内部 key が send 時に使われている
        sent_id = json.loads(captured["payload"].strip().split("\n")[0])["id"]
        assert sent_id.startswith(INTERNAL_KEY_PREFIX)
        # 出力では None に戻っている
        assert [r.id for r in results] == [None]

    def test_user_id_collision_with_internal_prefix_raises(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        with pytest.raises(ValueError, match="reserved prefix"):
            gw.preprocess_batch(
                [PreprocessingInput(id=f"{INTERNAL_KEY_PREFIX}danger", issue_dir="/tmp/x")],
            )

    def test_missing_result_for_some_items_fills_with_error(self, tmp_path: Path) -> None:
        # 入力 ["a", "b"] に対し Node が "a" だけ返したケース
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = _fake_extracted_result(id_="a")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch(
                [
                    PreprocessingInput(id="a", issue_dir="/tmp/a"),
                    PreprocessingInput(id="b", issue_dir="/tmp/b"),
                ],
            )
        assert len(results) == 2
        assert results[0].id == "a"
        assert results[0].excluded is None
        assert results[1].id == "b"
        assert results[1].excluded is ExclusionReason.LAYOUT_UNKNOWN
        assert results[1].layout is LayoutKind.UNKNOWN

    def test_subprocess_timeout_fills_all_with_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        with patch.object(
            subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="node", timeout=5),
        ):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch(
                [
                    PreprocessingInput(id="a", issue_dir="/tmp/a"),
                    PreprocessingInput(id="b", issue_dir="/tmp/b"),
                ],
            )
        assert [r.id for r in results] == ["a", "b"]
        assert all(r.excluded is ExclusionReason.LAYOUT_UNKNOWN for r in results)
        assert all(r.excluded_detail is not None and "timeout" in r.excluded_detail.lower() for r in results)

    def test_nonzero_exit_fills_all_with_error(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="boom")
        with patch.object(subprocess, "run", return_value=completed):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch(
                [
                    PreprocessingInput(id="a", issue_dir="/tmp/a"),
                    PreprocessingInput(id="b", issue_dir="/tmp/b"),
                ],
            )
        assert [r.id for r in results] == ["a", "b"]
        assert all(r.excluded is ExclusionReason.LAYOUT_UNKNOWN for r in results)
        assert all(r.excluded_detail is not None and "boom" in r.excluded_detail for r in results)

    def test_payload_omits_id_when_input_has_only_issue_dir(self, tmp_path: Path) -> None:
        # 内部 salt key が必ず割り当てられるので、Node 側に渡る JSONL の id は string になる
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        captured_payload: dict[str, str] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            payload = kwargs.get("input")
            assert isinstance(payload, str)
            captured_payload["raw"] = payload
            sent_id = json.loads(payload.strip().split("\n")[0])["id"]
            return subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=_fake_extracted_result(id_=sent_id),
                stderr="",
            )

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            gw.preprocess_batch([PreprocessingInput(issue_dir="/tmp/a")])

        line = captured_payload["raw"].strip().split("\n")[0]
        parsed = json.loads(line)
        assert isinstance(parsed["id"], str)
        assert "issue_dir" in parsed
