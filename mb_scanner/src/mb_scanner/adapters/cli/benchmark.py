"""ベンチマークデータ抽出CLIコマンド

JSONLファイルからslow/fastコードを読み込み、個別ファイルに展開します。
等価性チェック機能も提供します。
"""

import json
import os
from pathlib import Path
from typing import Any, cast

import typer

from mb_scanner.domain.entities.benchmark import BenchmarkEntry
from mb_scanner.infrastructure.config import settings
from mb_scanner.use_cases.benchmark_runner import run_batch_equivalence_check

benchmark_app = typer.Typer(help="Benchmark data commands")


def _is_primitive(v: Any) -> bool:
    return not isinstance(v, (dict, list))


def _serialize(obj: Any, level: int) -> str:
    indent = "  " * level
    inner = "  " * (level + 1)

    if isinstance(obj, list):
        obj_list = cast(list[Any], obj)
        if not obj_list:
            return "[]"
        # 全要素がプリミティブの場合のみ1行でコンパクト表示
        if all(_is_primitive(item) for item in obj_list):
            items = [json.dumps(item, ensure_ascii=False) for item in obj_list]
            return "[" + ", ".join(items) + "]"
        # 複雑な要素（dict, list）を含む場合 → 展開表示
        parts = [f"{inner}{_serialize(item, level + 1)}" for item in obj_list]
        return "[\n" + ",\n".join(parts) + "\n" + indent + "]"

    if isinstance(obj, dict):
        obj_dict = cast(dict[str, Any], obj)
        if not obj_dict:
            return "{}"
        parts = [f"{inner}{json.dumps(k, ensure_ascii=False)}: {_serialize(v, level + 1)}" for k, v in obj_dict.items()]
        return "{\n" + ",\n".join(parts) + "\n" + indent + "}"

    return json.dumps(obj, ensure_ascii=False)


def compact_json_array(json_str: str) -> str:
    """JSON文字列内の配列をコンパクト表示する

    - プリミティブ値のみの配列: 1行でコンパクト表示
    - フラットなdictのみの配列: 1行でコンパクト表示
    - 複雑な構造を含む配列: 展開表示

    Args:
        json_str: JSON文字列

    Returns:
        配列をコンパクト表示したJSON文字列
    """
    return _serialize(json.loads(json_str), 0)


def format_json_compact_arrays(data: dict[str, Any]) -> str:
    """配列をコンパクト表示したJSON文字列を生成する

    Args:
        data: JSONにシリアライズするデータ

    Returns:
        配列をコンパクト表示したJSON文字列
    """
    return _serialize(data, 0)


@benchmark_app.command("extract")
def extract(
    input_file: Path = typer.Argument(
        ...,
        help="入力JSONLファイルのパス",
    ),
    id_filter: int | None = typer.Option(
        None,
        "--id",
        help="特定のIDのみ抽出",
    ),
    ids_filter: str | None = typer.Option(
        None,
        "--ids",
        help="カンマ区切りで複数ID指定 (例: 0,1,2,3)",
    ),
    count: int | None = typer.Option(
        None,
        "--count",
        help="抽出する件数",
    ),
    offset: int = typer.Option(
        0,
        "--offset",
        help="開始位置（0始まり）",
    ),
    output_dir: Path | None = typer.Option(
        None,
        "--output-dir",
        help="出力先ディレクトリ（デフォルト: 入力ファイルと同じディレクトリ）",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="既存ファイルを上書き",
    ),
) -> None:
    """JSONLファイルからslow/fastコードを個別ファイルに展開する

    各エントリは id_{id}/slow.js と id_{id}/fast.js として出力されます。
    """
    if not input_file.exists():
        typer.echo(typer.style(f"Error: Input file not found: {input_file}", fg=typer.colors.RED), err=True)
        raise typer.Exit(code=1)

    # 出力先ディレクトリの決定
    dest_dir = output_dir or input_file.parent

    # ID フィルタの解析
    target_ids: set[int] | None = None
    if id_filter is not None:
        target_ids = {id_filter}
    elif ids_filter is not None:
        target_ids = {int(id_str.strip()) for id_str in ids_filter.split(",")}

    # JSONLファイルの読み込みとフィルタリング
    entries: list[BenchmarkEntry] = []
    with input_file.open("r", encoding="utf-8") as f:
        for line_num, raw_line in enumerate(f):
            stripped = raw_line.strip()
            if not stripped:
                continue

            # offset適用
            if line_num < offset:
                continue

            entry = BenchmarkEntry.model_validate_json(stripped)

            # IDフィルタ適用
            if target_ids is not None and entry.id not in target_ids:
                continue

            entries.append(entry)

            # count制限
            if count is not None and len(entries) >= count:
                break

    # ファイル展開
    created = 0
    skipped = 0

    for entry in entries:
        entry_dir = dest_dir / f"id_{entry.id}"

        if entry_dir.exists() and not force:
            skipped += 1
            continue

        entry_dir.mkdir(parents=True, exist_ok=True)
        (entry_dir / "slow.js").write_text(entry.slow, encoding="utf-8")
        (entry_dir / "fast.js").write_text(entry.fast, encoding="utf-8")
        created += 1

    total = created + skipped
    typer.echo(f"Total: {total} | Created: {created} | Skipped: {skipped}")


@benchmark_app.command("equivalence-check")
def equivalence_check(
    input_dir: Path = typer.Argument(
        ...,
        help="[DEPRECATED] id_* ディレクトリを含む親ディレクトリのパス",
    ),
    id_filter: int | None = typer.Option(
        None,
        "--id",
        help="特定のIDのみチェック",
    ),
    ids_filter: str | None = typer.Option(
        None,
        "--ids",
        help="カンマ区切りで複数ID指定 (例: 0,1,2,3)",
    ),
    count: int | None = typer.Option(
        None,
        "--count",
        help="チェックする件数",
    ),
    offset: int = typer.Option(
        0,
        "--offset",
        help="開始位置（0始まり）",
    ),
    timeout: int = typer.Option(
        100,
        "--timeout",
        help="1件あたりのタイムアウト（秒）",
    ),
    workers: int = typer.Option(
        4,
        "--workers",
        help="並列ワーカー数（-1で全CPUコアを使用）",
    ),
    output: Path | None = typer.Option(
        None,
        "--output",
        help="結果JSONファイルの出力先",
    ),
) -> None:
    """slow/fastコードの実行結果が等価かを検証する（DEPRECATED）

    DEPRECATED: このコマンドは将来廃止されます。
    後継は `mbs check-equivalence`（1トリプル単位の判定、4 oracle 対応）。

    extractで展開したディレクトリを対象に、各エントリの
    slow.jsとfast.jsの実行結果を比較します。
    """
    typer.echo(
        "[DEPRECATED] `benchmark equivalence-check` は将来廃止されます。"
        "後継: `mbs check-equivalence`（Phase 10 で提供予定）",
        err=True,
    )
    if not input_dir.exists():
        typer.echo(
            typer.style(f"Error: Directory not found: {input_dir}", fg=typer.colors.RED),
            err=True,
        )
        raise typer.Exit(code=1)

    # IDフィルタの解析
    target_ids: set[int] | None = None
    if id_filter is not None:
        target_ids = {id_filter}
    elif ids_filter is not None:
        target_ids = {int(id_str.strip()) for id_str in ids_filter.split(",")}

    typer.echo(f"Running equivalence check on {input_dir} ...")

    # ワーカー数の表示
    actual_workers = os.cpu_count() if workers == -1 else workers
    typer.echo(f"Using {actual_workers} workers (workers={workers})")

    summary = run_batch_equivalence_check(
        input_dir=input_dir,
        target_ids=target_ids,
        count=count,
        offset=offset,
        timeout=timeout,
        workers=workers,
        runner_js_path=settings.effective_benchmark_runner_js_path,
    )

    # 結果表示
    typer.echo(
        f"Total: {summary.total} | Equal: {summary.equal} | Not Equal: {summary.not_equal} "
        f"| Error: {summary.error} | Timeout: {summary.timeout} | Skipped: {summary.skipped}"
    )

    # JSON出力
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        # 配列をコンパクト表示したJSON文字列を生成
        # model_dump(mode='json')を使ってfield_serializerを適用
        # 大量データのため深さ制限を増やす（デフォルト: 255 → 512）
        try:
            json_str = format_json_compact_arrays(summary.model_dump(mode="json"))
        except ValueError as e:
            if "Circular reference" in str(e) or "depth exceeded" in str(e):
                # 深さ制限エラーの場合、Python標準のjson.dumpsで直接シリアライズ
                typer.echo("Warning: Using fallback JSON serialization due to depth limit", err=True)
                json_str = format_json_compact_arrays(json.loads(summary.model_dump_json()))
            else:
                raise
        output.write_text(json_str, encoding="utf-8")
        typer.echo(f"Results saved to {output}")


if __name__ == "__main__":
    benchmark_app()
