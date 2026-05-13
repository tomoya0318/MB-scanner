"""Pruning CLI コマンド

- ``mbs prune``: 1 トリプル pruning。終了コード pruned=0 / initial_mismatch=1 / error=2。
- ``mbs prune-batch``: JSONL 入力による複数トリプルの一括 pruning。Python 側
  ThreadPoolExecutor で並列化する (TS 側は 1 subprocess = 逐次)。

Node ランナー (``mb-analyzer/dist/cli.js``) を subprocess 経由で呼び出す
Gateway を use case に注入し、結果を JSON / JSONL で返す。
"""

from collections import Counter
from collections.abc import Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
from pathlib import Path
import sys
from typing import Annotated, Any, cast

from pydantic import ValidationError
import typer

from mb_scanner.adapters.cli._utils import resolve_workers
from mb_scanner.adapters.gateways.pruning import (
    INTERNAL_KEY_PREFIX,
    NodeRunnerPrunerGateway,
)
from mb_scanner.domain.entities.pruning import (
    PruningInput,
    PruningResult,
    PruningVerdict,
)
from mb_scanner.domain.ports.pruner import PrunerPort
from mb_scanner.infrastructure.config import settings
from mb_scanner.use_cases.pruning import PruningUseCase

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

pruning_app = typer.Typer(help="Pruning commands")

# CLI 補完用の実用デフォルト。``entities.pruning`` の ``DEFAULT_*`` は engine 暴走防止の
# 上限値 (`5_000ms × 1_000` = 1 トリプル worst case 約 83 分) で、実用デフォルトとしては
# 大きすぎる。Selakovic は 10^2 オーダで収束する想定 (entities/pruning.py のコメント参照)
# のため、暫定で狭めに設定し、timeout エラーが多発するようなら緩める運用。
# TODO: Selakovic 実測後に再調整
CLI_DEFAULT_TIMEOUT_MS = 2_000
CLI_DEFAULT_MAX_ITERATIONS = 200

EXIT_PRUNED = 0
EXIT_INITIAL_MISMATCH = 1
EXIT_ERROR = 2

EXIT_BATCH_OK = 0
EXIT_BATCH_ERROR = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _verdict_to_exit_code(verdict: PruningVerdict) -> int:
    if verdict is PruningVerdict.PRUNED:
        return EXIT_PRUNED
    if verdict is PruningVerdict.INITIAL_MISMATCH:
        return EXIT_INITIAL_MISMATCH
    return EXIT_ERROR


def _build_input(
    *,
    input_path: Path | None,
    setup: str | None,
    slow: str | None,
    fast: str | None,
    timeout_ms: int,
    max_iterations: int,
) -> PruningInput:
    if input_path is not None:
        raw = json.loads(input_path.read_text())
        if not isinstance(raw, dict):
            raise typer.BadParameter(f"{input_path}: top-level JSON must be an object")
        # CLI 引数が明示的に与えられていれば上書き
        payload: dict[str, Any] = dict(cast("dict[str, Any]", raw))
        if setup is not None:
            payload["setup"] = setup
        if slow is not None:
            payload["slow"] = slow
        if fast is not None:
            payload["fast"] = fast
        payload.setdefault("timeout_ms", timeout_ms)
        payload.setdefault("max_iterations", max_iterations)
        return PruningInput.model_validate(payload)

    if slow is None or fast is None:
        raise typer.BadParameter(
            "Either --input FILE or both --slow and --fast must be provided.",
        )
    return PruningInput(
        setup=setup or "",
        slow=slow,
        fast=fast,
        timeout_ms=timeout_ms,
        max_iterations=max_iterations,
    )


def _write_output(result: PruningResult, output_path: Path | None) -> None:
    text = result.model_dump_json(indent=2)
    if output_path is None:
        typer.echo(text)
        return
    output_path.write_text(text + "\n")


def _load_batch_inputs(
    input_path: Path,
    *,
    default_timeout_ms: int,
    default_max_iterations: int,
) -> list[PruningInput]:
    """JSONL ファイルから ``PruningInput`` リストを構築する

    timeout_ms / max_iterations の解決規約:
        - JSONL 行に値あり → その値を優先
        - JSONL 行に値なし → 引数の default で補う

    id が欠落している場合は ``line-NNNN`` で自動補完する (Gateway でのマッピング用)。
    Gateway の予約 prefix と衝突する id は事前条件違反として ``BadParameter`` にする。
    """
    inputs: list[PruningInput] = []
    text = input_path.read_text()
    for idx, raw_line in enumerate(text.splitlines()):
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload: Any = json.loads(line)
        except json.JSONDecodeError as e:
            raise typer.BadParameter(
                f"{input_path}:{idx + 1}: failed to parse JSON line: {e}",
            ) from e
        if not isinstance(payload, dict):
            raise typer.BadParameter(f"{input_path}:{idx + 1}: each line must be a JSON object")

        line_payload = cast("dict[str, Any]", payload)
        line_payload.setdefault("timeout_ms", default_timeout_ms)
        line_payload.setdefault("max_iterations", default_max_iterations)
        line_payload.setdefault("id", f"line-{idx + 1:04d}")

        try:
            parsed_input = PruningInput.model_validate(line_payload)
        except ValidationError as e:
            raise typer.BadParameter(f"{input_path}:{idx + 1}: invalid input: {e}") from e

        if parsed_input.id is not None and parsed_input.id.startswith(INTERNAL_KEY_PREFIX):
            raise typer.BadParameter(
                f"{input_path}:{idx + 1}: id {parsed_input.id!r} collides with internal "
                f"reserved prefix {INTERNAL_KEY_PREFIX!r}",
            )
        inputs.append(parsed_input)

    return inputs


def _chunked(items: Sequence[PruningInput], batch_size: int) -> Iterator[list[PruningInput]]:
    for start in range(0, len(items), batch_size):
        yield list(items[start : start + batch_size])


def _write_batch_output(results: Sequence[PruningResult], output_path: Path | None) -> None:
    lines = [result.model_dump_json() for result in results]
    text = "\n".join(lines) + ("\n" if lines else "")
    if output_path is None:
        sys.stdout.write(text)
        sys.stdout.flush()
        return
    output_path.write_text(text)


def _summarize(results: Sequence[PruningResult]) -> str:
    counts: Counter[PruningVerdict] = Counter(r.verdict for r in results)
    return (
        f"[summary] total={len(results)} "
        f"pruned={counts.get(PruningVerdict.PRUNED, 0)} "
        f"initial_mismatch={counts.get(PruningVerdict.INITIAL_MISMATCH, 0)} "
        f"error={counts.get(PruningVerdict.ERROR, 0)}"
    )


def _run_batch(
    pruner: PrunerPort,
    inputs: Sequence[PruningInput],
    *,
    workers: int,
    batch_size: int,
) -> list[PruningResult]:
    """ThreadPoolExecutor で inputs を分割並列実行して結果を入力順で返す"""
    if len(inputs) == 0:
        return []

    use_case = PruningUseCase(pruner)
    batches = list(_chunked(inputs, batch_size))
    total_batches = len(batches)

    # batch index → 結果
    batch_results: dict[int, list[PruningResult]] = {}

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(use_case.prune_batch, batch): batch_idx for batch_idx, batch in enumerate(batches)}
        # 完了順に回収する。挿入順で iterate すると先頭 future が遅い場合に他の完了分で
        # ブロックしてしまい、並列性と進捗表示の両方が損なわれる。
        for done_count, future in enumerate(as_completed(futures), start=1):
            batch_idx = futures[future]
            batch_results[batch_idx] = future.result()
            sys.stderr.write(f"[progress] {done_count}/{total_batches} batches done\n")
            sys.stderr.flush()

    out: list[PruningResult] = []
    for idx in range(total_batches):
        out.extend(batch_results[idx])
    return out


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@pruning_app.command("prune")
def prune(
    input_path: Annotated[
        Path | None,
        typer.Option(
            "--input",
            "-i",
            help='入力 JSON ファイル (`{"setup","slow","fast","timeout_ms","max_iterations"}`)',
        ),
    ] = None,
    setup: Annotated[str | None, typer.Option("--setup", help="setup コード断片")] = None,
    slow: Annotated[str | None, typer.Option("--slow", help="slow コード断片")] = None,
    fast: Annotated[str | None, typer.Option("--fast", help="fast コード断片")] = None,
    timeout_ms: Annotated[
        int,
        typer.Option("--timeout-ms", help="sandbox 内部タイムアウト (ms)"),
    ] = CLI_DEFAULT_TIMEOUT_MS,
    max_iterations: Annotated[
        int,
        typer.Option("--max-iterations", help="pruning ループの最大反復回数"),
    ] = CLI_DEFAULT_MAX_ITERATIONS,
    output_path: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="結果 JSON を書き出すファイル（未指定で stdout）"),
    ] = None,
) -> None:
    """1 トリプル (setup, slow, fast) を Node ランナーで pruning し、結果を JSON で出力する。

    終了コード: pruned=0 / initial_mismatch=1 / error=2
    """
    try:
        input_model = _build_input(
            input_path=input_path,
            setup=setup,
            slow=slow,
            fast=fast,
            timeout_ms=timeout_ms,
            max_iterations=max_iterations,
        )
    except FileNotFoundError as e:
        typer.echo(f"Input file not found: {e}", err=True)
        raise typer.Exit(EXIT_ERROR) from e
    except (json.JSONDecodeError, ValueError) as e:
        typer.echo(f"Invalid input: {e}", err=True)
        raise typer.Exit(EXIT_ERROR) from e

    gateway = NodeRunnerPrunerGateway(
        cli_path=settings.effective_mb_analyzer_cli_path,
        node_bin=settings.mb_analyzer_node_bin,
    )
    use_case = PruningUseCase(gateway)
    result = use_case.prune(input_model)
    _write_output(result, output_path)
    sys.exit(_verdict_to_exit_code(result.verdict))


@pruning_app.command("prune-batch")
def prune_batch(
    input_path: Annotated[
        Path,
        typer.Option(
            "--input",
            "-i",
            help="JSONL 入力ファイル (1 行 1 トリプル)",
        ),
    ],
    output_path: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help="JSONL 結果を書き出すファイル（未指定で stdout）",
        ),
    ] = None,
    workers: Annotated[
        int,
        typer.Option("--workers", help="並列度。-1 で os.cpu_count()"),
    ] = -1,
    batch_size: Annotated[
        int,
        typer.Option(
            "--batch-size",
            help="1 subprocess あたりのトリプル数。0 で auto (max(10, ceil(total / workers)))",
        ),
    ] = 0,
    timeout_ms: Annotated[
        int,
        typer.Option(
            "--timeout-ms",
            help="sandbox 内部タイムアウト (ms)。JSONL 行に timeout_ms が無い場合の補完値",
        ),
    ] = CLI_DEFAULT_TIMEOUT_MS,
    max_iterations: Annotated[
        int,
        typer.Option(
            "--max-iterations",
            help="pruning ループ最大反復回数。JSONL 行に max_iterations が無い場合の補完値",
        ),
    ] = CLI_DEFAULT_MAX_ITERATIONS,
) -> None:
    """JSONL 入力から複数トリプルを並列 pruning し、結果を JSONL で出力する。

    nohup 実行を前提にした非対話 CLI で、進捗は stderr に簡潔に出力する。
    終了コード: 正常 0 / I/O・バリデーション失敗 2。
    """
    try:
        actual_workers = resolve_workers(workers)
    except ValueError as e:
        typer.echo(f"Invalid --workers: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e

    try:
        inputs = _load_batch_inputs(
            input_path,
            default_timeout_ms=timeout_ms,
            default_max_iterations=max_iterations,
        )
    except typer.BadParameter as e:
        typer.echo(f"Invalid input: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e
    except FileNotFoundError as e:
        typer.echo(f"Input file not found: {input_path}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e

    if len(inputs) == 0:
        _write_batch_output([], output_path)
        sys.stderr.write(_summarize([]) + "\n")
        sys.stderr.flush()
        raise typer.Exit(EXIT_BATCH_OK)

    effective_batch_size = batch_size if batch_size > 0 else max(10, math.ceil(len(inputs) / actual_workers))

    gateway = NodeRunnerPrunerGateway(
        cli_path=settings.effective_mb_analyzer_cli_path,
        node_bin=settings.mb_analyzer_node_bin,
    )
    results = _run_batch(
        gateway,
        inputs,
        workers=actual_workers,
        batch_size=effective_batch_size,
    )
    _write_batch_output(results, output_path)
    sys.stderr.write(_summarize(results) + "\n")
    sys.stderr.flush()
