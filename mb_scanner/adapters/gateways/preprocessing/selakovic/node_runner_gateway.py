"""Node.js ランナー経由の Selakovic 前処理 Gateway

`mb-analyzer/dist/cli.js` をサブプロセスで起動し、stdin に JSON を流し込んで
stdout から JSONL (1 結果 = 1 行) を受け取る。

**1 入力 → N 結果モデル**:
Selakovic の同一 PR に複数の独立した最適化が同居するケースを扱うため、Node 側
``preprocess-selakovic`` / ``preprocess-selakovic-batch`` は常に **JSONL** で 1 入力
あたり 1+ 行を返す。Python 側もリストで受ける。

複数結果の場合の id 規則:
- 1 candidate のみ: ``id`` = original_id (suffix なし)
- N candidates (N >= 2): ``id`` = ``<original_id>#<index>``

Batch では prefix-match で対応付ける (``original_id`` で始まる id を全部集める)。
"""

from collections.abc import Sequence
import json
from pathlib import Path
import secrets
import subprocess

from pydantic import ValidationError

from mb_scanner.domain.entities.preprocessing import (
    ExclusionReason,
    LayoutKind,
    PreprocessingInput,
    PreprocessingResult,
)

# 1 issue あたりに想定する subprocess 処理時間 (秒)。
_SECONDS_PER_ITEM = 5.0
_BATCH_TIMEOUT_BUFFER_SEC = 30.0
INTERNAL_KEY_PREFIX = "__mb_preprocess_batch_idx__"


class NodeRunnerPreprocessorGateway:
    """Node ランナー経由の ``PreprocessorPort`` 実装

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

    def preprocess(self, input_: PreprocessingInput) -> list[PreprocessingResult]:
        """1 issue を Node ランナーに送り、結果配列を返す。

        Returns:
            1 件以上の ``PreprocessingResult``。1 candidate なら 1 件、N candidates なら
            N 件。subprocess 失敗等は 1 件の error result。
        """
        if not self._cli_path.exists():
            return [_gateway_error(_cli_not_found_message(self._cli_path), id_=input_.id)]

        # exclude_none=True: id 未設定時に "id": null を送らず、フィールドごと省略する
        # (Node 側契約: 省略 = string ではない、として扱う)。
        payload = input_.model_dump_json(exclude_none=True)
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
            return [_gateway_error(
                f"Node runner exceeded subprocess timeout ({subprocess_timeout:.1f}s)",
                id_=input_.id,
            )]
        except FileNotFoundError as e:
            return [_gateway_error(f"Failed to spawn Node runner: {e}", id_=input_.id)]

        if proc.returncode != 0:
            stderr = proc.stderr.strip() or "(no stderr)"
            return [_gateway_error(
                f"Node runner exited with code {proc.returncode}: {stderr}",
                id_=input_.id,
            )]

        results = _parse_jsonl_results(proc.stdout)
        if not results:
            return [_gateway_error(
                f"Node runner returned no parseable results: {proc.stderr.strip() or '(no stderr)'}",
                id_=input_.id,
            )]
        return results

    def preprocess_batch(self, items: Sequence[PreprocessingInput]) -> list[PreprocessingResult]:
        """複数 issue を 1 回の subprocess 起動でまとめて前処理する。

        - Node 側 ``preprocess-selakovic-batch`` は常に return code 0 を返し、各 issue の
          結果は JSONL の 1+ 行として stdout に書かれる
        - **id 突き合わせは prefix-match**: 1 入力に対し N 結果が ``<batch_key>``
          または ``<batch_key>#<idx>`` で返ってくるので、その全行を集める
        - 入力に対応する結果が 1 件もなければ error 系で埋める
        """
        if len(items) == 0:
            return []

        if not self._cli_path.exists():
            message = _cli_not_found_message(self._cli_path)
            return [_gateway_error(message, id_=item.id) for item in items]

        invocation_salt = secrets.token_hex(8)
        indexed: list[tuple[str, str | None, PreprocessingInput]] = []
        for idx, item in enumerate(items):
            original_id = item.id
            if item.id is not None:
                if item.id.startswith(INTERNAL_KEY_PREFIX):
                    raise ValueError(
                        f"Input id {item.id!r} collides with internal reserved prefix "
                        f"{INTERNAL_KEY_PREFIX!r}. Use a different id scheme.",
                    )
                key = item.id
                sent_item = item
            else:
                key = _batch_key(invocation_salt, idx)
                sent_item = item.model_copy(update={"id": key})
            indexed.append((key, original_id, sent_item))

        # sent_item.id は indexed 構築で必ず文字列が埋まっているので、exclude_none=True でも
        # 送信時に id フィールドが落ちることはない。
        payload_lines = [sent_item.model_dump_json(exclude_none=True) for _, _, sent_item in indexed]
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
            return [_gateway_error(f"Failed to spawn Node runner: {e}", id_=original_id) for _, original_id, _ in indexed]

        if proc.returncode != 0:
            stderr = proc.stderr.strip() or "(no stderr)"
            msg = f"Node runner (batch) exited with code {proc.returncode}: {stderr}"
            return [_gateway_error(msg, id_=original_id) for _, original_id, _ in indexed]

        # 全行を parse して、id ごとに集約
        all_results = _parse_jsonl_results(proc.stdout)

        # batch_key (= 入力 id) で prefix match して、対応する結果を全部集める
        # 例: batch_key="foo", 結果 id="foo" / "foo#0" / "foo#1" のいずれかが含まれる
        out: list[PreprocessingResult] = []
        for key, original_id, _sent in indexed:
            matched = [r for r in all_results if _matches_key(r.id, key)]
            if not matched:
                out.append(
                    _gateway_error(
                        "Node runner did not return any result for this item (possible subprocess crash mid-batch).",
                        id_=original_id,
                    ),
                )
                continue

            for r in matched:
                # 元 input に id が無かった場合は出力でも None / suffix 付与だけにする
                if original_id is None:
                    out.append(r.model_copy(update={"id": None}))
                else:
                    # batch_key を original_id に置換 (suffix は保持)
                    new_id = _replace_id_prefix(r.id, key, original_id)
                    out.append(r.model_copy(update={"id": new_id}))

        return out


def _parse_jsonl_results(stdout: str) -> list[PreprocessingResult]:
    """JSONL (1 行 1 result) を parse する。壊れた行は無視。"""
    results: list[PreprocessingResult] = []
    for raw_line in stdout.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            results.append(PreprocessingResult.model_validate(raw))
        except ValidationError:
            continue
    return results


def _matches_key(result_id: str | None, batch_key: str) -> bool:
    """``result_id`` が ``batch_key`` または ``batch_key#<index>`` 形式かを判定。"""
    if result_id is None:
        return False
    if result_id == batch_key:
        return True
    return result_id.startswith(f"{batch_key}#")


def _replace_id_prefix(result_id: str | None, old_prefix: str, new_prefix: str) -> str | None:
    """``result_id`` の prefix を ``new_prefix`` に置換する。

    ``result_id`` が ``old_prefix`` または ``old_prefix#X`` 形式の場合のみ置換。
    一致しなければ元の id を返す。
    """
    if result_id is None:
        return None
    if result_id == old_prefix:
        return new_prefix
    if result_id.startswith(f"{old_prefix}#"):
        return f"{new_prefix}{result_id[len(old_prefix):]}"
    return result_id


def _cli_not_found_message(cli_path: Path) -> str:
    return f"mb-analyzer CLI bundle not found: {cli_path}. Run `mise run build-analyzer` first."


def _batch_key(invocation_salt: str, idx: int) -> str:
    return f"{INTERNAL_KEY_PREFIX}{invocation_salt}_{idx}"


def _gateway_error(message: str, *, id_: str | None = None) -> PreprocessingResult:
    """Gateway レベル (subprocess 失敗等) のエラーを ``LAYOUT_UNKNOWN`` で表現する。"""
    return PreprocessingResult(
        id=id_,
        layout=LayoutKind.UNKNOWN,
        excluded=ExclusionReason.LAYOUT_UNKNOWN,
        excluded_detail=message,
    )
