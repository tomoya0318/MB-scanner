"""DEPRECATED: ベンチマーク等価性チェックサービス

DEPRECATED: このモジュールは将来廃止されます。
後継は `mb_scanner.use_cases.equivalence_verification`（1トリプル単位、4 oracle 対応）。

Node.jsスクリプト (`mb-analyzer-legacy/apps/equivalence-runner/dist/index.js`) を使って
slow/fastコードの等価性を検証するサービスです。
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import subprocess
import warnings

from mb_scanner.domain.entities.benchmark import EquivalenceResult, EquivalenceSummary


def run_equivalence_check(
    entry_dir: Path,
    timeout: int = 100,
    *,
    runner_js_path: Path,
) -> EquivalenceResult:
    """単一エントリの等価性チェックを実行する（DEPRECATED）

    DEPRECATED: この関数は将来廃止されます。
    後継は `EquivalenceVerificationUseCase`（Phase 8 で提供予定）。

    Args:
        entry_dir: id_{id} ディレクトリのパス（slow.js / fast.js を含む）
        timeout: Node.js実行のタイムアウト秒数
        runner_js_path: ベンチマークランナーJSファイルのパス

    Returns:
        EquivalenceResult: チェック結果
    """
    warnings.warn(
        "run_equivalence_check は将来廃止されます。"
        "後継: mb_scanner.use_cases.equivalence_verification.EquivalenceVerificationUseCase",
        DeprecationWarning,
        stacklevel=2,
    )
    dir_name = entry_dir.name
    entry_id = int(dir_name.replace("id_", ""))

    slow_path = entry_dir / "slow.js"
    fast_path = entry_dir / "fast.js"

    if not slow_path.exists() or not fast_path.exists():
        return EquivalenceResult(
            id=entry_id,
            status="error",
            error_message=f"Missing slow.js or fast.js in {entry_dir}",
        )

    try:
        proc = subprocess.run(
            [
                "node",
                str(runner_js_path),
                str(slow_path),
                str(fast_path),
                str(timeout * 1000),
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 5,  # Node.js内部タイムアウト + マージン
            check=False,
        )

        if proc.returncode != 0:
            return EquivalenceResult(
                id=entry_id,
                status="error",
                error_message=proc.stderr.strip() or "Node.js process exited with non-zero code",
            )

        result_data = json.loads(proc.stdout.strip())

        return EquivalenceResult(
            id=entry_id,
            status=result_data["status"],
            strategy_results=result_data.get("strategy_results", []),
            error_message=result_data.get("error_message"),
        )

    except subprocess.TimeoutExpired:
        return EquivalenceResult(
            id=entry_id,
            status="timeout",
            error_message=f"Timed out after {timeout} seconds",
        )
    except json.JSONDecodeError as e:
        return EquivalenceResult(
            id=entry_id,
            status="error",
            error_message=f"Failed to parse Node.js output: {e}",
        )


def run_batch_equivalence_check(
    input_dir: Path,
    target_ids: set[int] | None = None,
    count: int | None = None,
    offset: int = 0,
    timeout: int = 100,
    workers: int = 4,
    *,
    runner_js_path: Path,
) -> EquivalenceSummary:
    """バッチで等価性チェックを実行する（DEPRECATED）

    DEPRECATED: この関数は将来廃止されます。
    後継は `EquivalenceVerificationUseCase` の呼び出し（ループ処理は呼び出し側の責務）。

    Args:
        input_dir: id_* ディレクトリを含む親ディレクトリ
        target_ids: チェック対象のIDセット（Noneで全件）
        count: チェックする最大件数
        offset: 開始位置（ソート後のインデックス）
        timeout: 1件あたりのタイムアウト秒数
        workers: 並列ワーカー数（-1で全CPUコアを使用）
        runner_js_path: ベンチマークランナーJSファイルのパス

    Returns:
        EquivalenceSummary: 全体のサマリー
    """
    warnings.warn(
        "run_batch_equivalence_check は将来廃止されます。後継: EquivalenceVerificationUseCase をループで呼び出すこと",
        DeprecationWarning,
        stacklevel=2,
    )
    # id_* ディレクトリを検索してソート
    entry_dirs = sorted(
        [d for d in input_dir.iterdir() if d.is_dir() and d.name.startswith("id_")],
        key=lambda d: int(d.name.replace("id_", "")),
    )

    # フィルタリング
    if target_ids is not None:
        entry_dirs = [d for d in entry_dirs if int(d.name.replace("id_", "")) in target_ids]

    # offset / count 適用
    entry_dirs = entry_dirs[offset:]
    if count is not None:
        entry_dirs = entry_dirs[:count]

    # workers が -1 の場合は全CPUコアを使用（cpu_count() が None の環境では 1 にフォールバック）
    actual_workers = (os.cpu_count() or 1) if workers == -1 else workers
    if actual_workers < 1:
        raise ValueError(f"workers must be >= 1 (got {actual_workers})")

    # 並列実行
    with ThreadPoolExecutor(max_workers=actual_workers) as executor:
        futures = {
            executor.submit(run_equivalence_check, entry_dir, timeout, runner_js_path=runner_js_path): entry_dir
            for entry_dir in entry_dirs
        }
        results = [future.result() for future in as_completed(futures)]

    # IDでソートして結果の順序を保証
    results.sort(key=lambda r: r.id)

    # サマリー集計
    status_counts = {"equal": 0, "not_equal": 0, "error": 0, "timeout": 0, "skipped": 0}
    for r in results:
        status_counts[r.status] += 1

    return EquivalenceSummary(
        total=len(results),
        equal=status_counts["equal"],
        not_equal=status_counts["not_equal"],
        error=status_counts["error"],
        timeout=status_counts["timeout"],
        skipped=status_counts["skipped"],
        results=results,
    )
