"""Selakovic 10 パターン fixture による等価性検証の回帰テスト

- fixture は `tests/fixtures/selakovic/pattern_*.json` に配置される
- 各 fixture は `setup` / `before` / `after` / `expected_verdict` を必須で持つ
- `expected_primary_oracles` は参考情報（主担当 oracle）
- 実行には `mb-analyzer/dist/cli.js` のビルドが必要
"""

import json
from pathlib import Path

import pytest

from mb_scanner.equivalence.gateway import NodeRunnerEquivalenceGateway
from mb_scanner.equivalence.models import EquivalenceInput, Verdict
from mb_scanner.equivalence.verdict import EquivalenceVerificationUseCase

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = PROJECT_ROOT / "tests" / "fixtures" / "selakovic"
CLI_PATH = PROJECT_ROOT / "mb-analyzer" / "dist" / "cli.js"


def _load_fixtures() -> list[Path]:
    return sorted(FIXTURE_DIR.glob("pattern_*.json"))


@pytest.mark.integration
@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_selakovic_pattern(fixture_path: Path) -> None:
    if not CLI_PATH.exists():
        pytest.skip(f"mb-analyzer bundle not built: {CLI_PATH}")

    data = json.loads(fixture_path.read_text())
    input_ = EquivalenceInput(
        setup=data.get("setup", ""),
        before=data["before"],
        after=data["after"],
        timeout_ms=data.get("timeout_ms", 5000),
    )
    gateway = NodeRunnerEquivalenceGateway(CLI_PATH)
    use_case = EquivalenceVerificationUseCase(gateway)
    result = use_case.verify(input_)

    expected = Verdict(data["expected_verdict"])
    assert result.verdict is expected, (
        f"{fixture_path.stem}: got verdict={result.verdict}, expected={expected}; "
        f"observations={[o.model_dump() for o in result.observations]}; "
        f"error_message={result.error_message}"
    )

    expected_oracles = data.get("expected_primary_oracles", [])
    if expected_oracles and expected is Verdict.NOT_EQUAL:
        # 反例 fixture では、想定した oracle のいずれかで not_equal が観測されているべき
        not_equal_oracles = {o.oracle.value for o in result.observations if o.verdict.value == "not_equal"}
        assert not_equal_oracles.intersection(expected_oracles), (
            f"{fixture_path.stem}: expected one of {expected_oracles} to be not_equal, "
            f"but got not_equal_oracles={not_equal_oracles}"
        )


def test_fixture_count() -> None:
    """Selakovic 10 パターン + 反例 + 追加 = 12 個以上を維持"""
    assert len(_load_fixtures()) >= 12


@pytest.mark.integration
def test_selakovic_all_patterns_in_single_batch() -> None:
    """Selakovic fixture 全件を 1 バッチで処理する回帰テスト

    バッチ API が単発 × N 回と同じ結果を返すこと、および subprocess 起動が
    1 回に圧縮されることを確認する。
    """
    if not CLI_PATH.exists():
        pytest.skip(f"mb-analyzer bundle not built: {CLI_PATH}")

    fixtures = _load_fixtures()
    assert len(fixtures) >= 12

    inputs: list[EquivalenceInput] = []
    expected_by_id: dict[str, Verdict] = {}
    for path in fixtures:
        data = json.loads(path.read_text())
        fixture_id = path.stem  # 例: "pattern_01"
        inputs.append(
            EquivalenceInput(
                id=fixture_id,
                setup=data.get("setup", ""),
                before=data["before"],
                after=data["after"],
                timeout_ms=data.get("timeout_ms", 5000),
            ),
        )
        expected_by_id[fixture_id] = Verdict(data["expected_verdict"])

    gateway = NodeRunnerEquivalenceGateway(CLI_PATH)
    use_case = EquivalenceVerificationUseCase(gateway)
    results = use_case.verify_batch(inputs)

    assert len(results) == len(inputs)
    for result, input_ in zip(results, inputs, strict=True):
        expected = expected_by_id[input_.id or ""]
        assert result.id == input_.id
        assert result.verdict is expected, (
            f"{input_.id}: got verdict={result.verdict}, expected={expected}; error_message={result.error_message}"
        )


@pytest.mark.integration
def test_batch_timeout_ms_is_actually_passed_to_node() -> None:
    """timeout_ms=1 を Node に渡すと vm sandbox で発火し、effective_timeout_ms でエコーバックされる

    過去に Python→Node の timeout_ms 受け渡しがサイレントに DEFAULT=5000 に
    フォールバックしていた事例への回帰テスト。
    """
    if not CLI_PATH.exists():
        pytest.skip(f"mb-analyzer bundle not built: {CLI_PATH}")

    inputs = [
        EquivalenceInput(
            id="tight-timeout",
            before="while(true){}",
            after="while(true){}",
            timeout_ms=1,
        ),
    ]
    gateway = NodeRunnerEquivalenceGateway(CLI_PATH)
    results = gateway.check_batch(inputs)

    assert len(results) == 1
    assert results[0].id == "tight-timeout"
    # effective_timeout_ms で 1 がエコーバックされている = 値が checker まで届いている
    assert results[0].effective_timeout_ms == 1, (
        f"Expected Node to echo back effective_timeout_ms=1, got {results[0].effective_timeout_ms}. "
        "This likely means timeout_ms is being dropped between Python and Node."
    )
