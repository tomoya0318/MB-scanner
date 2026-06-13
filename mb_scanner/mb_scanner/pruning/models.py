"""Pruning (Hydra 式 AST 差分フィルタ) の入出力 Pydantic モデル

TypeScript 側の対応 contract との JSON シリアライゼーション契約。
フィールド名は snake_case、列挙値文字列も両言語で完全一致。
変更時は TypeScript 側の対応 contract と paired-change で同時に更新する。

- ``PruningInput`` は外部入力 (CLI/JSONL) のため ``extra="forbid"`` で典型ミスを弾く
- ``PruningResult`` は Node 側の将来フィールド追加に備えて ``extra="ignore"``

入出力の意味論的な詳細 (placeholder の AST 形、3 カテゴリの見え方、元コード衝突の扱い等)
は TS 側モジュールの README に集約: ``mb-analyzer/src/pruning/README.md`` §入出力契約。
"""

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from mb_scanner._runner import BatchItemModel

# ADR-0022 (workload-reachability) の changed-fn candidate は ``before``/``after`` は小さい (= 変更関数本体 + workload)
# が ``setup`` に lib 全文 (Ember 1.x ≈ 1.5MB + 依存 lib jquery/handlebars) を丸ごと残すので上限は大きめに取る。
# ``EquivalenceInput.MAX_CODE_LENGTH`` (= 20MB) と揃える — equiv を通った candidate は prune にも回せるべき。
MAX_CODE_LENGTH = 20_000_000
MIN_TIMEOUT_MS = 1
MAX_TIMEOUT_MS = 60_000
DEFAULT_TIMEOUT_MS = 5_000
DEFAULT_MAX_ITERATIONS = 1_000
MIN_MAX_ITERATIONS = 1
# Selakovic の pruning は 10^2 オーダで収束する想定。上限は桁違いに大きめに取り、
# 悪意 / 誤記載 (2**63 など) を弾く防衛線として 10^5 とする。
MAX_MAX_ITERATIONS = 100_000


class PruningVerdict(StrEnum):
    """pruning 全体判定"""

    PRUNED = "pruned"
    INITIAL_MISMATCH = "initial_mismatch"
    ERROR = "error"


class PlaceholderKind(StrEnum):
    """置換後のワイルドカード種別"""

    EXPRESSION = "expression"
    STATEMENT = "statement"
    IDENTIFIER = "identifier"


class Placeholder(BaseModel):
    """pruning の結果 AST に差し込まれるワイルドカード

    ``original_snippet`` は置換前の before コード片をそのまま保持し、第 2 段階で参照する。
    """

    model_config = ConfigDict(extra="ignore")

    id: str
    kind: PlaceholderKind
    original_snippet: str


class PruningInput(BatchItemModel):
    """Node ランナーへ送る pruning 入力

    ``setup`` を単数 string にした採用判断は ai-guide/adr/0004-pruning-setup-single.md 参照。

    ``environment`` / ``module_base_dir`` / ``mount_html`` は後段の等価検証
    (``mbs check-equivalence`` 相当) にそのまま渡される実行コンテキスト。pruning アルゴリズム
    本体 (TS ``pruning/common/``) はこれらを **解釈しない** — TS ``pruning/selakovic/`` が
    ``checkEquivalence`` 呼び出しの closure に閉じ込めるだけ。値の集合・意味論は
    ``mb_scanner.equivalence.models.EquivalenceInput`` と揃える (``environment`` 省略時
    は等価検証側で ``vm``、``module_base_dir`` は jsdom で相対 ``require('./x')`` の解決基準、
    ``mount_html`` は jsdom で mount する HTML)。pruning 用に ``extracted.jsonl`` から入力を組む層が
    ``module_base_dir``/``mount_html`` を補完する想定。
    """

    model_config = ConfigDict(extra="forbid")

    before: str = Field(max_length=MAX_CODE_LENGTH)
    after: str = Field(max_length=MAX_CODE_LENGTH)
    setup: str = Field(default="", max_length=MAX_CODE_LENGTH)
    timeout_ms: int = Field(default=DEFAULT_TIMEOUT_MS, ge=MIN_TIMEOUT_MS, le=MAX_TIMEOUT_MS)
    max_iterations: int = Field(default=DEFAULT_MAX_ITERATIONS, ge=MIN_MAX_ITERATIONS, le=MAX_MAX_ITERATIONS)
    # 等価検証へ pass-through する実行コンテキスト (pruning 本体は解釈しない)。
    # ``environment`` は ``"vm"`` | ``"jsdom"`` (値は equivalence/preprocessing 契約と一致)。
    environment: str | None = None
    module_base_dir: str | None = None
    mount_html: str | None = None
    # ADR-0023 D-β の placeholder substitution + 4 値契約フィールド。pruning 本体は解釈せず、
    # TS ``pruning/selakovic/`` が ``checkEquivalence`` の closure に閉じ込めて
    # ``EquivalenceInput.workload`` にそのまま流す。changed-fn 経路の candidate のみ非 None。
    workload: str | None = Field(default=None, max_length=MAX_CODE_LENGTH)


class PruningResult(BatchItemModel):
    """1 (before, after, setup) トリプルに対する pruning 最終結果

    verdict ごとに Node 側実装が **付与する想定** のフィールドは以下（スキーマでは任意）:

    - ``verdict == PRUNED``: ``pattern_ast`` / ``pattern_code`` / ``placeholders`` / ``iterations`` を付与
    - ``verdict == INITIAL_MISMATCH``: before ≢ after のため pruning 前段で停止、pattern 系は付与しない
    - ``verdict == ERROR``: parse 失敗やタイムアウトなど予期しない失敗。``error_message`` を付与

    スキーマ上は全て optional であり、verdict に応じた条件付き必須チェックは行わない
    (Node 側実装との契約は Gateway 層 / integration test で確認する想定)。

    ``pattern_ast`` は any-shape JSON で受ける (Babel AST シリアライズ結果)。statement
    placeholder は ``ExpressionStatement(Identifier("$Pn"))`` 形 (ADR-0009)、expression は
    ``StringLiteral("$Pn")``、identifier は ``Identifier("$Pn")`` 形で出力される。
    詳細は ``mb-analyzer/src/pruning/README.md`` §入出力契約。
    """

    model_config = ConfigDict(extra="ignore")

    verdict: PruningVerdict
    pattern_ast: JsonValue = None
    pattern_code: str | None = None
    placeholders: list[Placeholder] = Field(default_factory=list[Placeholder])
    iterations: int | None = None
    node_count_initial: int | None = None
    node_count_pruned: int | None = None
    effective_timeout_ms: int | None = None
    error_message: str | None = None
