"""等価性検証器の入出力 Pydantic モデル

Node.js 側 (`mb-analyzer/src/contracts/equivalence-contracts.ts`) と JSON シリアライゼーション
互換を保つ。フィールド名は snake_case、列挙値文字列も両言語で完全一致。

paired-change で更新する: ``mb-analyzer/src/contracts/equivalence-contracts.ts``。
"""

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

# Selakovic preprocess は作用点 A の clientIssue で bundled ライブラリ (AngularJS 665KB / Ember 2MB 等)
# を slow/fast に丸ごと埋め込むので、上限は大きめに取る (ADR-0011)。
MAX_CODE_LENGTH = 20_000_000
MIN_TIMEOUT_MS = 1
MAX_TIMEOUT_MS = 60_000
DEFAULT_TIMEOUT_MS = 5_000


class Verdict(StrEnum):
    """全体等価性判定"""

    EQUAL = "equal"
    NOT_EQUAL = "not_equal"
    ERROR = "error"


class OracleVerdict(StrEnum):
    """個別 oracle の判定"""

    EQUAL = "equal"
    NOT_EQUAL = "not_equal"
    NOT_APPLICABLE = "not_applicable"
    ERROR = "error"


class Oracle(StrEnum):
    """等価性の観測チャネル"""

    RETURN_VALUE = "return_value"
    ARGUMENT_MUTATION = "argument_mutation"
    EXCEPTION = "exception"
    EXTERNAL_OBSERVATION = "external_observation"


class ExecutionEnvironment(StrEnum):
    """実行環境 (ADR-0012)

    - ``VM``: 素の ``node:vm`` + 非決定 API stub。純粋計算向け。
    - ``JSDOM``: jsdom window/document + 相対 ``require`` 解決。browser ライブラリ
      (AngularJS / jQuery 等) / server ``test_case`` 向け (Phase 2a の最小版)。
    """

    VM = "vm"
    JSDOM = "jsdom"


class EquivalenceInput(BaseModel):
    """Node ランナーへ送る入力

    ``id`` はバッチ API で Python ↔ Node 間の順序暗黙依存を避けるための optional マーカー。
    単発 API では ``None`` のままで後方互換。

    ``environment`` 省略時は ``vm``。``module_base_dir`` は ``jsdom`` 環境で相対 ``require('./x')``
    を解決する基準ディレクトリ (通常 issue ディレクトリの絶対パス)。
    """

    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    setup: str = Field(default="", max_length=MAX_CODE_LENGTH)
    slow: str = Field(max_length=MAX_CODE_LENGTH)
    fast: str = Field(max_length=MAX_CODE_LENGTH)
    timeout_ms: int = Field(default=DEFAULT_TIMEOUT_MS, ge=MIN_TIMEOUT_MS, le=MAX_TIMEOUT_MS)
    environment: ExecutionEnvironment | None = None
    module_base_dir: str | None = None


class OracleObservation(BaseModel):
    """1 oracle の観測結果"""

    model_config = ConfigDict(extra="ignore")

    oracle: Oracle
    verdict: OracleVerdict
    slow_value: str | None = None
    fast_value: str | None = None
    detail: str | None = None


class EquivalenceCheckResult(BaseModel):
    """(setup, slow, fast) の 1 トリプルに対する最終判定

    ``effective_timeout_ms`` は Node の checker が実際に使った timeout_ms。
    過去に Python→Node への timeout_ms 受け渡しが機能せずサイレントに DEFAULT=5000 で
    実行される事例があったため、Node 側がエコーバックした値を Python 側で検証可能にする。
    """

    model_config = ConfigDict(extra="ignore")

    id: str | None = None
    verdict: Verdict
    observations: list[OracleObservation] = Field(default_factory=list[OracleObservation])
    error_message: str | None = None
    effective_timeout_ms: int | None = None
