"""等価性検証 CLI コマンド

- ``mbs check-equivalence``: 1 トリプル検証。終了コード equal=0 / not_equal=1 / inconclusive=2 / error=3。
- ``mbs check-equivalence-batch``: JSONL 入力による複数トリプルの一括検証。Python 側 ThreadPoolExecutor で並列化する。

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

from mb_scanner._utils import resolve_workers
from mb_scanner.config import settings
from mb_scanner.equivalence.gateway import EquivalenceCheckerPort, NodeRunnerEquivalenceGateway
from mb_scanner.equivalence.models import (
    DEFAULT_TIMEOUT_MS,
    EquivalenceCheckResult,
    EquivalenceInput,
    Verdict,
)
from mb_scanner.equivalence.verdict import EquivalenceVerificationUseCase

equivalence_app = typer.Typer(help="Equivalence verification commands")

EXIT_EQUAL = 0
EXIT_NOT_EQUAL = 1
EXIT_INCONCLUSIVE = 2
# `error` verdict と入力パース失敗 (どちらも「使える verdict が出せなかった」) を 3 に統一。
EXIT_ERROR = 3

EXIT_BATCH_OK = 0
EXIT_BATCH_ERROR = 2


def _verdict_to_exit_code(verdict: Verdict) -> int:
    if verdict is Verdict.EQUAL:
        return EXIT_EQUAL
    if verdict is Verdict.NOT_EQUAL:
        return EXIT_NOT_EQUAL
    if verdict is Verdict.INCONCLUSIVE:
        return EXIT_INCONCLUSIVE
    return EXIT_ERROR


def _build_input(
    *,
    input_path: Path | None,
    setup: str | None,
    before: str | None,
    after: str | None,
    timeout_ms: int,
) -> EquivalenceInput:
    if input_path is not None:
        raw = json.loads(input_path.read_text())
        if not isinstance(raw, dict):
            raise typer.BadParameter(f"{input_path}: top-level JSON must be an object")
        # CLI 引数が明示的に与えられていれば上書き
        payload: dict[str, Any] = dict(cast("dict[str, Any]", raw))
        if setup is not None:
            payload["setup"] = setup
        if before is not None:
            payload["before"] = before
        if after is not None:
            payload["after"] = after
        payload.setdefault("timeout_ms", timeout_ms)
        return EquivalenceInput.model_validate(payload)

    if before is None or after is None:
        raise typer.BadParameter(
            "Either --input FILE or both --before and --after must be provided.",
        )
    return EquivalenceInput(
        setup=setup or "",
        before=before,
        after=after,
        timeout_ms=timeout_ms,
    )


def _write_output(result: EquivalenceCheckResult, output_path: Path | None) -> None:
    text = result.model_dump_json(indent=2)
    if output_path is None:
        typer.echo(text)
        return
    output_path.write_text(text + "\n")


def _load_batch_inputs(input_path: Path, default_timeout_ms: int) -> list[EquivalenceInput]:
    """JSONL ファイルから ``EquivalenceInput`` リストを構築する

    timeout_ms の解決規約:
        - JSONL 行に timeout_ms **あり** → その値を優先
        - JSONL 行に timeout_ms **なし** → ``default_timeout_ms`` (CLI デフォルト) で補う

    id が欠落している場合は ``line-NNNN`` で自動補完する (Gateway でのマッピング用)。
    """
    inputs: list[EquivalenceInput] = []
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
        line_payload.setdefault("id", f"line-{idx + 1:04d}")

        try:
            inputs.append(EquivalenceInput.model_validate(line_payload))
        except ValidationError as e:
            raise typer.BadParameter(f"{input_path}:{idx + 1}: invalid input: {e}") from e

    return inputs


def _chunked(items: Sequence[EquivalenceInput], batch_size: int) -> Iterator[list[EquivalenceInput]]:
    for start in range(0, len(items), batch_size):
        yield list(items[start : start + batch_size])


def _write_batch_output(results: Sequence[EquivalenceCheckResult], output_path: Path | None) -> None:
    lines = [result.model_dump_json() for result in results]
    text = "\n".join(lines) + ("\n" if lines else "")
    if output_path is None:
        sys.stdout.write(text)
        sys.stdout.flush()
        return
    output_path.write_text(text)


def _summarize(results: Sequence[EquivalenceCheckResult]) -> str:
    counts: Counter[Verdict] = Counter(r.verdict for r in results)
    return (
        f"[summary] total={len(results)} "
        f"equal={counts.get(Verdict.EQUAL, 0)} "
        f"not_equal={counts.get(Verdict.NOT_EQUAL, 0)} "
        f"inconclusive={counts.get(Verdict.INCONCLUSIVE, 0)} "
        f"error={counts.get(Verdict.ERROR, 0)}"
    )


def _run_batch(
    checker: EquivalenceCheckerPort,
    inputs: Sequence[EquivalenceInput],
    *,
    workers: int,
    batch_size: int,
) -> list[EquivalenceCheckResult]:
    """ThreadPoolExecutor で inputs を分割並列実行して結果を入力順で返す"""
    if len(inputs) == 0:
        return []

    use_case = EquivalenceVerificationUseCase(checker)
    batches = list(_chunked(inputs, batch_size))
    total_batches = len(batches)

    # batch index → 結果
    batch_results: dict[int, list[EquivalenceCheckResult]] = {}

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(use_case.verify_batch, batch): batch_idx for batch_idx, batch in enumerate(batches)}
        # 完了順に回収する。挿入順で iterate すると先頭 future が遅い場合に他の完了分で
        # ブロックしてしまい、並列性と進捗表示の両方が損なわれる。
        for done_count, future in enumerate(as_completed(futures), start=1):
            batch_idx = futures[future]
            batch_results[batch_idx] = future.result()
            sys.stderr.write(f"[progress] {done_count}/{total_batches} batches done\n")
            sys.stderr.flush()

    out: list[EquivalenceCheckResult] = []
    for idx in range(total_batches):
        out.extend(batch_results[idx])
    return out


@equivalence_app.command("check-equivalence")
def check_equivalence(
    input_path: Annotated[
        Path | None,
        typer.Option(
            "--input",
            "-i",
            help='入力 JSON ファイル (`{"setup","before","after","timeout_ms"}`)',
        ),
    ] = None,
    setup: Annotated[str | None, typer.Option("--setup", help="setup コード断片")] = None,
    before: Annotated[str | None, typer.Option("--before", help="before コード断片")] = None,
    after: Annotated[str | None, typer.Option("--after", help="after コード断片")] = None,
    timeout_ms: Annotated[
        int,
        typer.Option("--timeout-ms", help="sandbox 内部タイムアウト (ms)"),
    ] = DEFAULT_TIMEOUT_MS,
    output_path: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="結果 JSON を書き出すファイル（未指定で stdout）"),
    ] = None,
) -> None:
    """1 トリプル (setup, before, after) を Node ランナーで検証し、結果を JSON で出力する。

    終了コード: equal=0 / not_equal=1 / inconclusive=2 / error=3 (入力パース失敗も 3)
    """
    try:
        input_model = _build_input(
            input_path=input_path,
            setup=setup,
            before=before,
            after=after,
            timeout_ms=timeout_ms,
        )
    except (json.JSONDecodeError, ValueError) as e:
        typer.echo(f"Invalid input: {e}", err=True)
        raise typer.Exit(EXIT_ERROR) from e

    gateway = NodeRunnerEquivalenceGateway(
        cli_path=settings.effective_mb_analyzer_cli_path,
        node_bin=settings.mb_analyzer_node_bin,
    )
    use_case = EquivalenceVerificationUseCase(gateway)
    result = use_case.verify(input_model)
    _write_output(result, output_path)
    sys.exit(_verdict_to_exit_code(result.verdict))


@equivalence_app.command("check-equivalence-batch")
def check_equivalence_batch(
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
    ] = DEFAULT_TIMEOUT_MS,
) -> None:
    """JSONL 入力から複数トリプルを並列検証し、結果を JSONL で出力する。

    nohup 実行を前提にした非対話 CLI で、進捗は stderr に簡潔に出力する。
    終了コード: 正常 0 / I/O・バリデーション失敗 2。
    """
    try:
        actual_workers = resolve_workers(workers)
    except ValueError as e:
        typer.echo(f"Invalid --workers: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e

    try:
        inputs = _load_batch_inputs(input_path, default_timeout_ms=timeout_ms)
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

    gateway = NodeRunnerEquivalenceGateway(
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
