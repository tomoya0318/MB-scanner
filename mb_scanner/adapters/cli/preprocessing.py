"""Preprocessing CLI コマンド

- ``mbs preprocess-selakovic``: 1 issue の前処理。stdin/stdout JSON。
- ``mbs preprocess-selakovic-batch``: 入力モード 2 種:
  - ``--input <jsonl>``: JSONL の各行を 1 issue として処理
  - ``--dataset <root>``: Selakovic dataset 配下の全 issue を自動列挙して処理

並列化は pruning と同じく Python 側 ThreadPoolExecutor で chunk を並列に投げる
(Node 側 1 subprocess = 逐次)。
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
from mb_scanner.adapters.gateways.preprocessing import (
    INTERNAL_KEY_PREFIX,
    NodeRunnerPreprocessorGateway,
    scan_selakovic_dataset,
)
from mb_scanner.domain.entities.preprocessing import (
    ExclusionReason,
    LayoutKind,
    PreprocessingInput,
    PreprocessingResult,
)
from mb_scanner.domain.ports.preprocessor import PreprocessorPort
from mb_scanner.infrastructure.config import settings
from mb_scanner.use_cases.preprocessing.selakovic import SelakovicPreprocessingUseCase

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

preprocessing_app = typer.Typer(help="Dataset preprocessing commands")

EXIT_OK = 0
EXIT_ERROR = 2

EXIT_BATCH_OK = 0
EXIT_BATCH_ERROR = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_single_output(results: Sequence[PreprocessingResult], output_path: Path | None) -> None:
    """単発 CLI の出力。

    1 入力 → N 結果モデルなので常に JSONL で出力する (1 結果でも 1 行 JSONL、
    N 結果なら N 行)。
    """
    lines = [r.model_dump_json() for r in results]
    text = "\n".join(lines) + ("\n" if lines else "")
    if output_path is None:
        sys.stdout.write(text)
        sys.stdout.flush()
        return
    output_path.write_text(text)


def _build_inputs_from_jsonl(input_path: Path) -> list[PreprocessingInput]:
    """JSONL ファイルから ``PreprocessingInput`` リストを構築する。

    各行は ``{"id"?: str, "issue_dir": str}`` の JSON object。``id`` 欠落時は
    ``line-NNNN`` で自動補完する (Gateway でのマッピング用)。
    """
    inputs: list[PreprocessingInput] = []
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
        line_payload.setdefault("id", f"line-{idx + 1:04d}")

        try:
            parsed_input = PreprocessingInput.model_validate(line_payload)
        except ValidationError as e:
            raise typer.BadParameter(f"{input_path}:{idx + 1}: invalid input: {e}") from e

        if parsed_input.id is not None and parsed_input.id.startswith(INTERNAL_KEY_PREFIX):
            raise typer.BadParameter(
                f"{input_path}:{idx + 1}: id {parsed_input.id!r} collides with internal "
                f"reserved prefix {INTERNAL_KEY_PREFIX!r}",
            )
        inputs.append(parsed_input)

    return inputs


def _build_inputs_from_dataset(dataset_root: Path) -> list[PreprocessingInput]:
    """Selakovic dataset 配下の全 issue ディレクトリから ``PreprocessingInput`` を構築する。

    ``id`` には ``<category>/<lib>/<issue_id>`` 形式の自然な識別子を付与する
    (line-NNNN より集計レポートで読みやすい)。
    """
    # scan_selakovic_dataset は resolve() 済みの絶対パスを返すので、relative_to が
    # 失敗しないよう dataset_root も resolve しておく。
    resolved_root = dataset_root.resolve()
    issue_dirs = scan_selakovic_dataset(resolved_root)
    inputs: list[PreprocessingInput] = []
    for issue_dir in issue_dirs:
        # <dataset_root>/clientIssues/AngularIssues/issues/issue_4359 → "clientIssues/AngularIssues/issue_4359"
        try:
            rel = issue_dir.relative_to(resolved_root)
            parts = rel.parts
            if len(parts) >= 4 and parts[2] == "issues":
                identifier = f"{parts[0]}/{parts[1]}/{parts[3]}"
            else:
                identifier = rel.as_posix()
        except ValueError:
            identifier = issue_dir.name
        inputs.append(PreprocessingInput(id=identifier, issue_dir=str(issue_dir)))
    return inputs


def _chunked(items: Sequence[PreprocessingInput], batch_size: int) -> Iterator[list[PreprocessingInput]]:
    for start in range(0, len(items), batch_size):
        yield list(items[start : start + batch_size])


def _write_batch_output(results: Sequence[PreprocessingResult], output_path: Path | None) -> None:
    lines = [result.model_dump_json() for result in results]
    text = "\n".join(lines) + ("\n" if lines else "")
    if output_path is None:
        sys.stdout.write(text)
        sys.stdout.flush()
        return
    output_path.write_text(text)


def _summarize(results: Sequence[PreprocessingResult], *, input_count: int) -> str:
    """抽出成功 / 除外内訳を 1 行に集約する。

    1 入力 → N 結果モデルでは結果数 != 入力数になりうるため、両方を表示する。

    Args:
        results: フラット化された結果列
        input_count: 入力 issue 数 (= ``len(items)``)
    """
    total_results = len(results)
    extracted = sum(1 for r in results if r.excluded is None)
    layouts: Counter[LayoutKind] = Counter(r.layout for r in results)
    exclusions: Counter[ExclusionReason] = Counter(r.excluded for r in results if r.excluded is not None)

    # `<input.id>#<idx>` 形式で複数結果を持つ入力を「複数 candidate を持つ」とカウント
    multi_candidate_inputs = sum(1 for r in results if r.id is not None and "#" in r.id)
    # 厳密には base id で集計するべきだが、簡易表示として候補行数を示す

    parts = [
        f"[summary] inputs={input_count}",
        f"results={total_results}",
        f"extracted={extracted}",
    ]
    if multi_candidate_inputs > 0:
        parts.append(f"multi-candidate-rows={multi_candidate_inputs}")
    parts.extend(f"{layout.value}={count}" for layout, count in sorted(layouts.items()))
    if exclusions:
        parts.append("excluded={" + ", ".join(f"{r.value}={c}" for r, c in sorted(exclusions.items())) + "}")
    return " ".join(parts)


def _run_batch(
    preprocessor: PreprocessorPort,
    inputs: Sequence[PreprocessingInput],
    *,
    workers: int,
    batch_size: int,
) -> list[PreprocessingResult]:
    """ThreadPoolExecutor で inputs を分割並列実行して結果を入力順で返す。"""
    if len(inputs) == 0:
        return []

    use_case = SelakovicPreprocessingUseCase(preprocessor)
    batches = list(_chunked(inputs, batch_size))
    total_batches = len(batches)

    batch_results: dict[int, list[PreprocessingResult]] = {}

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(use_case.preprocess_batch, batch): batch_idx for batch_idx, batch in enumerate(batches)
        }
        for done_count, future in enumerate(as_completed(futures), start=1):
            batch_idx = futures[future]
            batch_results[batch_idx] = future.result()
            sys.stderr.write(f"[progress] {done_count}/{total_batches} batches done\n")
            sys.stderr.flush()

    out: list[PreprocessingResult] = []
    for idx in range(total_batches):
        out.extend(batch_results[idx])
    return out


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@preprocessing_app.command("preprocess-selakovic")
def preprocess_selakovic(
    issue_dir: Annotated[
        Path,
        typer.Option("--issue-dir", "-i", help="Selakovic issue ディレクトリ (絶対 or 相対パス)"),
    ],
    issue_id: Annotated[
        str | None,
        typer.Option("--id", help="出力に付与する任意の id (省略時は None)"),
    ] = None,
    output_path: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="結果 JSON を書き出すファイル (未指定で stdout)"),
    ] = None,
) -> None:
    """1 issue を Node ランナーで前処理し、結果を JSON で出力する。

    終了コード: 抽出成功 = 0、抽出失敗 (excluded を含む) も 0 (構造的エラーは 2)。
    抽出の良し悪しは出力 JSON の ``excluded`` フィールドで判別する。
    """
    if not issue_dir.is_dir():
        typer.echo(f"Issue dir not found or not a directory: {issue_dir}", err=True)
        raise typer.Exit(EXIT_ERROR)

    input_model = PreprocessingInput(id=issue_id, issue_dir=str(issue_dir.resolve()))
    gateway = NodeRunnerPreprocessorGateway(
        cli_path=settings.effective_mb_analyzer_cli_path,
        node_bin=settings.mb_analyzer_node_bin,
    )
    use_case = SelakovicPreprocessingUseCase(gateway)
    results = use_case.preprocess(input_model)
    _write_single_output(results, output_path)
    sys.exit(EXIT_OK)


@preprocessing_app.command("preprocess-selakovic-batch")
def preprocess_selakovic_batch(
    input_path: Annotated[
        Path | None,
        typer.Option(
            "--input",
            "-i",
            help='JSONL 入力ファイル (1 行 1 issue: `{"id"?, "issue_dir"}`)',
        ),
    ] = None,
    dataset_root: Annotated[
        Path | None,
        typer.Option(
            "--dataset",
            "-d",
            help="Selakovic dataset ルート (例: data/selakovic-2016-issues)。"
            "指定すると配下の全 issue を自動列挙する",
        ),
    ] = None,
    output_path: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help="JSONL 結果を書き出すファイル (未指定で stdout)",
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
            help="1 subprocess あたりの issue 数。0 で auto (max(10, ceil(total / workers)))",
        ),
    ] = 0,
) -> None:
    """複数 issue を並列前処理し、結果を JSONL で出力する。

    入力モード:
        - ``--input <jsonl>``: JSONL の各行を 1 issue として処理
        - ``--dataset <root>``: Selakovic dataset 配下の全 issue を自動列挙

    両方指定するとエラー、両方未指定もエラー。
    nohup 実行を前提にした非対話 CLI で、進捗は stderr に簡潔に出力する。
    """
    if (input_path is None) == (dataset_root is None):
        typer.echo("Specify exactly one of --input or --dataset.", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR)

    try:
        actual_workers = resolve_workers(workers)
    except ValueError as e:
        typer.echo(f"Invalid --workers: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e

    try:
        if input_path is not None:
            inputs = _build_inputs_from_jsonl(input_path)
        else:
            assert dataset_root is not None  # narrowed by branch above
            inputs = _build_inputs_from_dataset(dataset_root)
    except typer.BadParameter as e:
        typer.echo(f"Invalid input: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e
    except FileNotFoundError as e:
        typer.echo(f"Input not found: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e
    except NotADirectoryError as e:
        typer.echo(f"Dataset root is not a directory: {e}", err=True)
        raise typer.Exit(EXIT_BATCH_ERROR) from e

    if len(inputs) == 0:
        _write_batch_output([], output_path)
        sys.stderr.write(_summarize([], input_count=0) + "\n")
        sys.stderr.flush()
        raise typer.Exit(EXIT_BATCH_OK)

    effective_batch_size = batch_size if batch_size > 0 else max(10, math.ceil(len(inputs) / actual_workers))

    gateway = NodeRunnerPreprocessorGateway(
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
    sys.stderr.write(_summarize(results, input_count=len(inputs)) + "\n")
    sys.stderr.flush()
