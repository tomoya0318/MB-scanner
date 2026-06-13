"""Node.js ランナー経由の Selakovic 前処理 Gateway

`mb-analyzer/dist/cli.js` をサブプロセスで起動し、stdin に JSON を流し込んで
stdout から JSONL (1 行 = 1 IssueResult) を受け取る (ADR-0024)。

**1 入力 → 1 IssueResult モデル** (ADR-0024):
1 IssueResult が ``candidates: list[PreprocessingCandidate]`` を内包し、
1 issue 単位で id を直接対応させる。
"""

from collections.abc import Sequence
import json
from pathlib import Path
import secrets
import subprocess

from pydantic import ValidationError

from mb_scanner.domain.entities.preprocessing import (
    Aspect,
    LayoutKind,
    PreprocessingInput,
    PreprocessingIssueResult,
    SelakovicExclusionReason,
    SelakovicIssueMeta,
    WrapperKind,
)

# 1 issue あたりに想定する subprocess 処理時間 (秒)。
_SECONDS_PER_ITEM = 5.0
_BATCH_TIMEOUT_BUFFER_SEC = 30.0
INTERNAL_KEY_PREFIX = "__mb_preprocess_batch_idx__"


class NodeRunnerPreprocessorGateway:
    """Node ランナー経由の ``PreprocessorPort`` 実装 (ADR-0024)

    Args:
        cli_path: `mb-analyzer/dist/cli.js` の絶対パス
        node_bin: Node 実行ファイル
        timeout_margin_sec: subprocess 側の追加マージン秒数
    """

    def __init__(
        self,
        cli_path: Path,
        *,
        node_bin: str = "node",
        timeout_margin_sec: float = 5.0,
    ) -> None:
        self._cli_path = cli_path
        self._node_bin = node_bin
        self._timeout_margin_sec = timeout_margin_sec

    def preprocess(self, input_: PreprocessingInput) -> PreprocessingIssueResult:
        """1 issue を Node ランナーに送り、1 つの IssueResult を返す。"""
        if not self._cli_path.exists():
            return _gateway_error(_cli_not_found_message(self._cli_path), id_=input_.id)

        payload = input_.model_dump_json(exclude_defaults=False, exclude_none=False)
        subprocess_timeout = _SECONDS_PER_ITEM + self._timeout_margin_sec

        try:
            proc = subprocess.run(
                [self._node_bin, str(self._cli_path), "preprocess-selakovic"],
                input=payload,
                capture_output=True,
                text=True,
                timeout=subprocess_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return _gateway_error(
                f"Node runner exceeded subprocess timeout ({subprocess_timeout:.1f}s)",
                id_=input_.id,
            )
        except FileNotFoundError as e:
            return _gateway_error(f"Failed to spawn Node runner: {e}", id_=input_.id)

        if proc.returncode != 0:
            stderr = proc.stderr.strip() or "(no stderr)"
            return _gateway_error(
                f"Node runner exited with code {proc.returncode}: {stderr}",
                id_=input_.id,
            )

        results = _parse_jsonl_results(proc.stdout)
        if not results:
            return _gateway_error(
                f"Node runner returned no parseable results: {proc.stderr.strip() or '(no stderr)'}",
                id_=input_.id,
            )
        # 単発 CLI は 1 行 = 1 IssueResult なので最初の要素を返す
        return results[0]

    def preprocess_batch(self, items: Sequence[PreprocessingInput]) -> list[PreprocessingIssueResult]:
        """複数 issue を 1 回の subprocess 起動でまとめて前処理する (入力数 == 出力数)。"""
        if len(items) == 0:
            return []

        if not self._cli_path.exists():
            message = _cli_not_found_message(self._cli_path)
            return [_gateway_error(message, id_=item.id) for item in items]

        invocation_salt = secrets.token_hex(8)
        indexed: list[tuple[str, str | None, PreprocessingInput]] = []
        # batch_key (= subprocess に送る id) は input 内で一意でなければならない: 入力数 == 出力数の
        # 対応 (ADR-0024) を保つため、Node 側が echo back する id で result を引き当てる必要がある。
        # ユーザー指定 id が重複していると result_by_key で上書きされ、出力が同じ result で埋まる。
        seen_user_ids: set[str] = set()
        for idx, item in enumerate(items):
            original_id = item.id
            if item.id is not None:
                if item.id.startswith(INTERNAL_KEY_PREFIX):
                    raise ValueError(
                        f"Input id {item.id!r} collides with internal reserved prefix "
                        f"{INTERNAL_KEY_PREFIX!r}. Use a different id scheme.",
                    )
                if item.id in seen_user_ids:
                    raise ValueError(
                        f"Duplicate input id {item.id!r}: ids must be unique within a batch "
                        "to preserve input-order correspondence (ADR-0024).",
                    )
                seen_user_ids.add(item.id)
                key = item.id
                sent_item = item
            else:
                key = _batch_key(invocation_salt, idx)
                sent_item = item.model_copy(update={"id": key})
            indexed.append((key, original_id, sent_item))

        payload_lines = [
            sent_item.model_dump_json(exclude_defaults=False, exclude_none=False) for _, _, sent_item in indexed
        ]
        payload = "\n".join(payload_lines) + "\n"

        subprocess_timeout = _SECONDS_PER_ITEM * len(items) + _BATCH_TIMEOUT_BUFFER_SEC + self._timeout_margin_sec

        try:
            proc = subprocess.run(
                [self._node_bin, str(self._cli_path), "preprocess-selakovic-batch"],
                input=payload,
                capture_output=True,
                text=True,
                timeout=subprocess_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            msg = f"Node runner exceeded batch subprocess timeout ({subprocess_timeout:.1f}s)"
            return [_gateway_error(msg, id_=original_id) for _, original_id, _ in indexed]
        except FileNotFoundError as e:
            return [
                _gateway_error(f"Failed to spawn Node runner: {e}", id_=original_id) for _, original_id, _ in indexed
            ]

        if proc.returncode != 0:
            stderr = proc.stderr.strip() or "(no stderr)"
            msg = f"Node runner (batch) exited with code {proc.returncode}: {stderr}"
            return [_gateway_error(msg, id_=original_id) for _, original_id, _ in indexed]

        # 全行を parse して、id ごとに索引化
        all_results = _parse_jsonl_results(proc.stdout)
        result_by_key: dict[str, PreprocessingIssueResult] = {}
        for r in all_results:
            if r.id is not None:
                result_by_key[r.id] = r

        # 入力順に対応する結果を集める
        out: list[PreprocessingIssueResult] = []
        for key, original_id, _sent in indexed:
            r = result_by_key.get(key)
            if r is None:
                out.append(
                    _gateway_error(
                        "Node runner did not return any result for this item (possible subprocess crash mid-batch).",
                        id_=original_id,
                    ),
                )
                continue
            # batch_key を original_id に置換
            if original_id is None:
                out.append(r.model_copy(update={"id": None}))
            else:
                out.append(r.model_copy(update={"id": original_id}))

        return out


def _parse_jsonl_results(stdout: str) -> list[PreprocessingIssueResult]:
    """JSONL (1 行 1 IssueResult) を parse する。壊れた行は無視。"""
    results: list[PreprocessingIssueResult] = []
    for raw_line in stdout.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            results.append(PreprocessingIssueResult.model_validate(raw))
        except ValidationError:
            continue
    return results


def _cli_not_found_message(cli_path: Path) -> str:
    return f"mb-analyzer CLI bundle not found: {cli_path}. Run `mise run build-analyzer` first."


def _batch_key(invocation_salt: str, idx: int) -> str:
    return f"{INTERNAL_KEY_PREFIX}{invocation_salt}_{idx}"


def _gateway_error(message: str, *, id_: str | None = None) -> PreprocessingIssueResult:
    """Gateway レベル (subprocess 失敗等) のエラーを issue_excluded で表現する。"""
    return PreprocessingIssueResult(
        id=id_,
        issue_excluded=SelakovicExclusionReason.LAYOUT_UNKNOWN,
        issue_excluded_detail=message,
        candidates=[],
        candidate_count=0,
        issue_meta=SelakovicIssueMeta(
            adapter="selakovic",
            layout=LayoutKind.UNKNOWN,
            aspect=Aspect.FALLBACK,
            wrapper_kind=WrapperKind.TOP_LEVEL,
        ),
    )
