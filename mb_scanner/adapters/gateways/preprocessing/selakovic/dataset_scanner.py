"""Selakovic 2016 データセットの issue ディレクトリ列挙

`data/selakovic-2016-issues/{clientIssues,serverIssues,clientServerIssues}/<LibName>Issues/issues/<issue_id>/`
というフラットな配置を辿って issue dir のパス一覧を返す。

論文非依存: ファイル名・ディレクトリ名規則のみを使い、内容の構造規則 (`f1`, `init`/`setupTest`/`test`)
には依存しない。
"""

from collections.abc import Iterator
from pathlib import Path

# Selakovic データセットのルート直下に存在する 3 カテゴリ。
SELAKOVIC_CATEGORIES = ("clientIssues", "serverIssues", "clientServerIssues")


def scan_selakovic_dataset(dataset_root: Path) -> list[Path]:
    """``dataset_root`` 配下の全 issue ディレクトリを列挙する。

    Returns:
        各 issue ディレクトリの絶対パス。順序はカテゴリ → ライブラリ名 → issue id の
        辞書順で安定 (バッチ処理で再現性を保つため)。

    Raises:
        FileNotFoundError: ``dataset_root`` が存在しない場合。
        NotADirectoryError: ``dataset_root`` がディレクトリでない場合。
    """
    if not dataset_root.exists():
        raise FileNotFoundError(f"Selakovic dataset root not found: {dataset_root}")
    if not dataset_root.is_dir():
        raise NotADirectoryError(f"Selakovic dataset root is not a directory: {dataset_root}")

    issues = list(_iter_issue_dirs(dataset_root))
    return sorted(issues, key=lambda p: p.as_posix())


def _iter_issue_dirs(dataset_root: Path) -> Iterator[Path]:
    """``<dataset_root>/<category>/<lib>Issues/issues/<issue_id>/`` を yield する。"""
    for category in SELAKOVIC_CATEGORIES:
        category_dir = dataset_root / category
        if not category_dir.is_dir():
            continue
        for lib_dir in sorted(category_dir.iterdir()):
            if not lib_dir.is_dir():
                continue
            issues_dir = lib_dir / "issues"
            if not issues_dir.is_dir():
                continue
            for issue_dir in sorted(issues_dir.iterdir()):
                if issue_dir.is_dir():
                    yield issue_dir.resolve()
