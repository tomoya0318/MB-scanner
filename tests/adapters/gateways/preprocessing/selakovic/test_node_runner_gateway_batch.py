"""Node ランナー preprocessing Gateway (Selakovic) の batch API テスト (ADR-0024)

ADR-0024 で 1 入力 → 1 IssueResult モデルに変更 (旧 1 入力 → N flat result の prefix-match
集約は廃止)。入力数 == 出力数で id を直接対応させる。
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
    PreprocessingInput,
    SelakovicExclusionReason,
)

PROJECT_ROOT = Path(__file__).resolve().parents[5]
CLI_PATH = PROJECT_ROOT / "mb-analyzer" / "dist" / "cli.js"


def _gateway(cli_path: Path | None = None) -> NodeRunnerPreprocessorGateway:
    return NodeRunnerPreprocessorGateway(cli_path or CLI_PATH)


def _fake_issue_result(id_: str | None = None) -> str:
    """新 contract (ADR-0024) の 1 行 = 1 IssueResult fixture。"""
    payload: dict[str, object] = {
        "candidates": [
            {
                "setup": None,
                "slow": "arr[0]",
                "fast": "arr[1]",
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
        assert all(r.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN for r in results)
        assert [r.id for r in results] == ["a", "b"]

    def test_happy_path_with_id_echo_one_result_per_item(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = "\n".join(
            [
                _fake_issue_result(id_="a"),
                _fake_issue_result(id_="b"),
                _fake_issue_result(id_="c"),
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

    def test_input_without_id_uses_internal_salt_key_and_returns_none(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        captured: dict[str, str] = {}

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            payload = kwargs.get("input")
            assert isinstance(payload, str)
            captured["payload"] = payload
            sent_id = json.loads(payload.strip().split("\n")[0])["id"]
            stdout = _fake_issue_result(id_=sent_id)
            return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch([PreprocessingInput(issue_dir="/tmp/x")])

        sent_id = json.loads(captured["payload"].strip().split("\n")[0])["id"]
        assert sent_id.startswith(INTERNAL_KEY_PREFIX)
        assert [r.id for r in results] == [None]

    def test_user_id_collision_with_internal_prefix_raises(self, tmp_path: Path) -> None:
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        with pytest.raises(ValueError, match="reserved prefix"):
            gw.preprocess_batch(
                [PreprocessingInput(id=f"{INTERNAL_KEY_PREFIX}danger", issue_dir="/tmp/x")],
            )

    def test_duplicate_user_id_raises(self, tmp_path: Path) -> None:
        # ADR-0024 で 1 入力 → 1 IssueResult モデルなので、result_by_key で id ベースに
        # 引き当てる。duplicate user id は対応付けを破綻させるため reject。
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        gw = _gateway(fake_cli)
        with pytest.raises(ValueError, match="Duplicate input id"):
            gw.preprocess_batch(
                [
                    PreprocessingInput(id="dup", issue_dir="/tmp/a"),
                    PreprocessingInput(id="dup", issue_dir="/tmp/b"),
                ],
            )

    def test_multiple_none_ids_allowed(self, tmp_path: Path) -> None:
        # None id は内部 salt key で一意化されるので、複数 None でも OK
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")

        def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            payload = kwargs.get("input")
            assert isinstance(payload, str)
            lines = payload.strip().split("\n")
            stdouts = [_fake_issue_result(id_=json.loads(line)["id"]) for line in lines]
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="\n".join(stdouts), stderr="")

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            results = gw.preprocess_batch(
                [
                    PreprocessingInput(issue_dir="/tmp/a"),
                    PreprocessingInput(issue_dir="/tmp/b"),
                ],
            )
        assert len(results) == 2
        assert all(r.id is None for r in results)

    def test_missing_result_for_some_items_fills_with_error(self, tmp_path: Path) -> None:
        # 入力 ["a", "b"] に対し Node が "a" だけ返したケース
        fake_cli = tmp_path / "cli.js"
        fake_cli.write_text("// stub")
        stdout = _fake_issue_result(id_="a")
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
        assert results[0].issue_excluded is None
        assert results[1].id == "b"
        assert results[1].issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN

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
        assert all(r.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN for r in results)
        assert all(
            r.issue_excluded_detail is not None and "timeout" in r.issue_excluded_detail.lower() for r in results
        )

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
        assert all(r.issue_excluded is SelakovicExclusionReason.LAYOUT_UNKNOWN for r in results)
        assert all(r.issue_excluded_detail is not None and "boom" in r.issue_excluded_detail for r in results)

    def test_payload_omits_id_when_input_has_only_issue_dir(self, tmp_path: Path) -> None:
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
                stdout=_fake_issue_result(id_=sent_id),
                stderr="",
            )

        with patch.object(subprocess, "run", side_effect=fake_run):
            gw = _gateway(fake_cli)
            gw.preprocess_batch([PreprocessingInput(issue_dir="/tmp/a")])

        line = captured_payload["raw"].strip().split("\n")[0]
        parsed = json.loads(line)
        assert isinstance(parsed["id"], str)
        assert "issue_dir" in parsed
