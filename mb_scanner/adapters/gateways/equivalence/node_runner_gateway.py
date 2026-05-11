"""Node.js ランナー経由の等価性検証 Gateway

`mb-analyzer/dist/cli.js` をサブプロセスで起動し、stdin に JSON を流し込んで
stdout から JSON を受け取る。Pydantic で検証した上で domain 型として返す。
"""

from collections.abc import Sequence
import json
from pathlib import Path
import secrets
import subprocess

from pydantic import ValidationError

from mb_scanner.domain.entities.equivalence import (
    EquivalenceCheckResult,
    EquivalenceInput,
    Verdict,
)

_BATCH_TIMEOUT_BUFFER_SEC = 30.0
# バッチ呼び出しごとに生成する内部キーのプレフィックス。ユーザー指定の id と
# 衝突しないよう、secrets.token_hex で毎回ユニークにする。
_INTERNAL_KEY_PREFIX = "__mb_batch_idx__"


class NodeRunnerEquivalenceGateway:
    """Node ランナー経由の ``EquivalenceCheckerPort`` 実装

    Args:
        cli_path: `mb-analyzer/dist/cli.js` の絶対パス
        node_bin: Node 実行ファイル。PATH 上に `node` があればデフォルトで可。
        timeout_margin_sec: vm の timeout_ms に対する subprocess 側の追加マージン秒数
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

    def check(self, input_: EquivalenceInput) -> EquivalenceCheckResult:
        """1 トリプルを Node ランナーに送り、結果をドメインモデルに変換して返す。"""
        if not self._cli_path.exists():
            return _error(_cli_not_found_message(self._cli_path))

        payload = input_.model_dump_json()
        subprocess_timeout = input_.timeout_ms / 1000.0 + self._timeout_margin_sec

        try:
            proc = subprocess.run(
                [self._node_bin, str(self._cli_path), "check-equivalence"],
                input=payload,
                capture_output=True,
                text=True,
                timeout=subprocess_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return _error(
                f"Node runner exceeded subprocess timeout ({subprocess_timeout:.1f}s); "
                "the sandbox may have hung or the timeout_ms is too large.",
            )
        except FileNotFoundError as e:
            return _error(f"Failed to spawn Node runner: {e}")

        stdout = proc.stdout.strip()
        # 0=equal, 1=not_equal, 2=error; それ以外は予期しない失敗として扱う。
        # exit=2 でも stdout に error_message を含む JSON が来るのでパースを試みる
        # (Node 側の error_message を握りつぶさない)。
        if proc.returncode not in (0, 1, 2):
            stderr = proc.stderr.strip() or "(no stderr)"
            return _error(
                f"Node runner exited with code {proc.returncode}: {stderr}",
            )

        if not stdout:
            return _error(
                f"Node runner returned empty stdout (exit={proc.returncode}): {proc.stderr.strip() or '(no stderr)'}",
            )

        try:
            raw = json.loads(stdout)
        except json.JSONDecodeError as e:
            return _error(f"Failed to parse Node runner stdout as JSON: {e}; stdout={stdout[:200]!r}")

        try:
            return EquivalenceCheckResult.model_validate(raw)
        except ValidationError as e:
            return _error(f"Node runner response failed schema validation: {e}")

    def check_batch(self, items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]:
        """複数トリプルを 1 回の subprocess 起動でまとめて検証する。

        - Node 側 ``check-equivalence-batch`` サブコマンドは常に returncode 0 を返し、
          各トリプルの結果は JSONL の 1 行として stdout に書かれる。
        - ``id`` をキーに入力と突き合わせて順序を復元する。``id`` が欠落した入力には
          ``_batch_key(idx)`` を一時的に割り当てて突き合わせる。
        - subprocess 失敗・timeout・行数不足はすべて対応するアイテムを ``error`` verdict に畳む。
        - ``effective_timeout_ms`` が入力 ``timeout_ms`` と食い違う場合は warning を
          ``error_message`` に注入する (サイレント乖離の早期発見)。
        """
        if len(items) == 0:
            return []

        if not self._cli_path.exists():
            message = _cli_not_found_message(self._cli_path)
            return [_error(message, id_=item.id) for item in items]

        # 各 item に batch_key を割り当てる (id 優先、なければ内部ランダムキー)。
        # Node 側の parseBatchLine は id が文字列のときだけエコーバックするため、
        # 内部マッピング用に batch_key を Node に送り、出力側で元の id に戻す。
        # ユーザー id との衝突を避けるため、呼び出しごとにランダム suffix を生成する。
        invocation_salt = secrets.token_hex(8)
        indexed: list[tuple[str, str | None, EquivalenceInput]] = []
        for idx, item in enumerate(items):
            original_id = item.id
            if item.id is not None:
                # ユーザー提供の id が予約プレフィックスと衝突していないか早期検出。
                if item.id.startswith(_INTERNAL_KEY_PREFIX):
                    raise ValueError(
                        f"Input id {item.id!r} collides with internal reserved prefix "
                        f"{_INTERNAL_KEY_PREFIX!r}. Use a different id scheme.",
                    )
                key = item.id
                sent_item = item
            else:
                key = _batch_key(invocation_salt, idx)
                sent_item = item.model_copy(update={"id": key})
            indexed.append((key, original_id, sent_item))

        # JSONL 組み立て: exclude_defaults/exclude_none を明示して timeout_ms が
        # シリアライズから落ちる事故を将来のリファクタに対して防ぐ。
        payload_lines = [
            sent_item.model_dump_json(exclude_defaults=False, exclude_none=False) for _, _, sent_item in indexed
        ]
        payload = "\n".join(payload_lines) + "\n"

        subprocess_timeout = _batch_subprocess_timeout(items, self._timeout_margin_sec)

        try:
            proc = subprocess.run(
                [self._node_bin, str(self._cli_path), "check-equivalence-batch"],
                input=payload,
                capture_output=True,
                text=True,
                timeout=subprocess_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            msg = (
                f"Node runner exceeded batch subprocess timeout ({subprocess_timeout:.1f}s); "
                "the sandbox may have hung or the aggregated timeout_ms is too large."
            )
            return [_error(msg, id_=original_id) for _, original_id, _ in indexed]
        except FileNotFoundError as e:
            return [_error(f"Failed to spawn Node runner: {e}", id_=original_id) for _, original_id, _ in indexed]

        if proc.returncode != 0:
            stderr = proc.stderr.strip() or "(no stderr)"
            msg = f"Node runner (batch) exited with code {proc.returncode}: {stderr}"
            return [_error(msg, id_=original_id) for _, original_id, _ in indexed]

        # stdout を行ごとにパースして id → 結果のマップを作る。
        parsed_by_key: dict[str, EquivalenceCheckResult] = {}
        for raw_line in proc.stdout.split("\n"):
            line = raw_line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                # Node 側が壊れた行を吐いた場合はこの行を無視し、後段で欠落分として扱う。
                continue
            try:
                result = EquivalenceCheckResult.model_validate(raw)
            except ValidationError:
                continue
            if result.id is not None:
                parsed_by_key[result.id] = result

        # 入力順で結果を再構成。欠落があれば error で埋める。
        out: list[EquivalenceCheckResult] = []
        for key, original_id, sent_item in indexed:
            result = parsed_by_key.get(key)
            if result is None:
                out.append(
                    _error(
                        "Node runner did not return a result for this item (possible subprocess crash mid-batch).",
                        id_=original_id,
                    ),
                )
                continue

            # effective_timeout_ms の突き合わせ検証 (受け渡し乖離の早期発見)
            warning = _check_timeout_echo(sent_item.timeout_ms, result.effective_timeout_ms)
            # 元の input に id が無かった場合は出力でも None に戻す (呼び出し側の期待を維持)。
            updates: dict[str, object | None] = {"id": original_id}
            if warning is not None:
                existing = result.error_message
                updates["error_message"] = f"{existing}; {warning}" if existing else warning
            out.append(result.model_copy(update=updates))

        return out


def _cli_not_found_message(cli_path: Path) -> str:
    return f"mb-analyzer CLI bundle not found: {cli_path}. Run `mise run build-analyzer` first."


def _batch_key(invocation_salt: str, idx: int) -> str:
    return f"{_INTERNAL_KEY_PREFIX}{invocation_salt}_{idx}"


def _batch_subprocess_timeout(items: Sequence[EquivalenceInput], margin_sec: float) -> float:
    """バッチ全体の subprocess timeout を合計 timeout_ms から算出する。

    Node 側は逐次 await するので、各トリプルの vm timeout_ms の合計に
    起動コスト等のマージン (30s + margin_sec) を加える。
    """
    total_sec = sum(item.timeout_ms for item in items) / 1000.0
    return total_sec + _BATCH_TIMEOUT_BUFFER_SEC + margin_sec


def _check_timeout_echo(requested_ms: int, effective_ms: int | None) -> str | None:
    """Node が実際に使った timeout_ms を Python 側で検証する。

    - effective_ms が None (古い Node や error verdict で欠落) なら False 陽性を避けるため warning 無し
    - requested と異なる場合は警告文字列を返す (Python→Node 受け渡し失敗の早期発見)
    """
    if effective_ms is None:
        return None
    if effective_ms != requested_ms:
        return (
            f"timeout_ms mismatch: Python requested {requested_ms} but Node used {effective_ms}. "
            "Check JSON serialization between Python and Node."
        )
    return None


def _error(message: str, *, id_: str | None = None) -> EquivalenceCheckResult:
    # subprocess spawn 失敗 / JSON 解釈失敗 / timeout 等の Gateway 側 error は
    # 「使える verdict が出せなかった」= ADR-0018 の executor-error と同じ分類なので
    # verdict_reason を付ける (Node 側 outer catch が "executor-error" を付けるのと揃える)。
    return EquivalenceCheckResult(
        id=id_,
        verdict=Verdict.ERROR,
        observations=[],
        verdict_reason="executor-error",
        error_message=message,
    )
