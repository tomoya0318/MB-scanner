"""CLI アダプタ共通のユーティリティ

各 CLI コマンド間で重複する引数解決処理 (並列度など) を集約する。
"""

import os


def resolve_workers(workers: int) -> int:
    """``--workers`` 引数を実行時の並列度に解決する

    - ``-1`` → ``os.cpu_count() or 1``
    - ``>= 1`` → そのまま
    - それ以外 (``0``, ``<-1``) → ``ValueError``
    """
    if workers == -1:
        return os.cpu_count() or 1
    if workers < 1:
        raise ValueError(f"workers must be -1 or >= 1 (got {workers})")
    return workers
