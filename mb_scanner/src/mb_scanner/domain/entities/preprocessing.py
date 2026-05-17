"""Preprocessing (Selakovic データセット前処理) の入出力 Pydantic モデル

Node.js 側 (``mb-analyzer/src/contracts/preprocessing-contracts.ts``) と JSON シリアライ
ゼーション互換を保つ。フィールド名は snake_case、列挙値文字列も両言語で完全一致。

paired-change で更新する: ``mb-analyzer/src/contracts/preprocessing-contracts.ts``。

構造の方針 (ADR-0024):
    - **base contract**: 全 dataset で意味を持つフィールドのみ
    - **adapter extension**: dataset 固有情報は ``issue_meta`` / ``candidate_meta`` (discriminated union)
    - **issue 階層化**: jsonl 1 行 = 1 issue、``candidates: list[PreprocessingCandidate]``
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

# ============================================================================
# Base contract (dataset 非依存)
# ============================================================================


class ExclusionReasonBase(StrEnum):
    """全 dataset で意味を持つ汎用の除外理由

    dataset 固有の理由は ``SelakovicExclusionReason`` 等の adapter 側 enum に置く。
    ``issue_excluded`` / ``candidate_excluded`` フィールドは Union 型 ``ExclusionReasonAny`` を受ける。
    """

    PARSE_ERROR = "parse-error"
    NO_CHANGED_NODES = "no-changed-nodes"
    MULTI_FILE_CHANGE = "multi-file-change"
    MISSING_FILES = "missing-files"


class PreprocessingInput(BaseModel):
    """Node ランナーへ送る preprocessing 入力 (1 issue 分)

    ``id`` はバッチ API で Python ↔ Node 間の順序暗黙依存を避ける optional マーカー。
    ``issue_dir`` は絶対パスで、Node 側 CLI がファイル読み込み + レイアウト判定を行う。
    """

    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    issue_dir: str


# ============================================================================
# Selakovic adapter (dataset 固有)
# ============================================================================


class LayoutKind(StrEnum):
    """1 issue ディレクトリの物理レイアウト判定結果 (Selakovic dataset 構造)"""

    CLIENT = "client"
    SERVER = "server"
    UNKNOWN = "unknown"


class Aspect(StrEnum):
    """作用点ルーティングの結果 (ADR-0011 §段2、issue level)"""

    LIB = "lib"
    WORKLOAD = "workload"
    BOTH = "lib+workload"
    FALLBACK = "fallback"


class TargetSide(StrEnum):
    """出力候補がどっち側を表現しているか (candidate level、ADR-0024)

    ``aspect`` と語彙が重なる ("lib"/"workload") が、レベルが違う:
    ``aspect`` = 元 patch がどこにあるか (1 issue = 1 値)
    ``target_side`` = この candidate がどっち側を表現するか (1 candidate = 1 値)
    """

    LIB = "lib"
    WORKLOAD = "workload"
    BOTH = "both"


class WrapperKind(StrEnum):
    """f1 の wrap 構造 (ADR-0011 §段1)

    - ``TOP_LEVEL``: ``var f1 = function(){...}`` が Program 直下
    - ``ANGULAR_CONTROLLER_WRAPPER``: ``app.controller("Ctrl", function($scope){...})`` の中
    """

    TOP_LEVEL = "top_level"
    ANGULAR_CONTROLLER_WRAPPER = "angular_controller_wrapper"


class SelakovicExclusionReason(StrEnum):
    """Selakovic dataset 固有の除外理由 (ADR-0024 で base から分離)"""

    MODULE_WIDE_CHANGE = "module-wide-change"
    NO_ENCLOSURE_CANDIDATE = "no-enclosure-candidate"
    LAYOUT_UNKNOWN = "layout-unknown"
    CHANGE_NOT_EXERCISED = "change-not-exercised"


# Union 型 (base + Selakovic)
ExclusionReasonAny = ExclusionReasonBase | SelakovicExclusionReason


class SelakovicIssueMeta(BaseModel):
    """Selakovic adapter の issue level メタ (1 issue = 1 値)"""

    model_config = ConfigDict(extra="ignore")

    adapter: Literal["selakovic"] = "selakovic"
    layout: LayoutKind
    aspect: Aspect
    wrapper_kind: WrapperKind


class SelakovicCandidateMeta(BaseModel):
    """Selakovic adapter の candidate level メタ (1 candidate = 1 値)"""

    model_config = ConfigDict(extra="ignore")

    adapter: Literal["selakovic"] = "selakovic"
    target_side: TargetSide
    is_workload_reachable: bool


# ============================================================================
# Discriminated union (adapter 拡張ポイント)
# ============================================================================

# 現状 Selakovic adapter のみ。新 dataset 追加時は Union を広げる:
#   IssueMeta = Annotated[SelakovicIssueMeta | OtherIssueMeta, Field(discriminator="adapter")]
IssueMeta = Annotated[SelakovicIssueMeta, Field(discriminator="adapter")]
CandidateMeta = Annotated[SelakovicCandidateMeta, Field(discriminator="adapter")]


# ============================================================================
# Result types (base + adapter_meta)
# ============================================================================


class PreprocessingCandidate(BaseModel):
    """1 candidate の出力 (equivalence-checker の入力単位)

    ``candidate_excluded`` が指定されている場合 ``slow`` / ``fast`` / ``setup`` は ``None``。
    ``enclosure_node_type`` は抽出した最小 enclosure の AST ノード型名 (Babel ノード型、
    "FunctionDeclaration" / "BlockStatement" 等)。threats to validity 集計で「どの粒度に
    収束したか」を見るため (ADR-0010)。

    ``workload`` は ADR-0023 D-β の placeholder substitution + 4 値契約フィールド。
    ``setup`` に ``$BODY$`` プレースホルダを 1 個含み、``slow`` / ``fast`` を ``setup`` の
    ``$BODY$`` に差し込んで sandbox に渡す経路 (= changed-fn 経路) でのみ非 ``None``。
    それ以外の経路 (client embedded / fallback / server 等) では ``None``。
    """

    model_config = ConfigDict(extra="ignore")

    setup: str | None = None
    slow: str | None = None
    fast: str | None = None
    workload: str | None = None
    before_node_count: int | None = None
    after_node_count: int | None = None
    enclosure_node_type: str | None = None
    candidate_excluded: ExclusionReasonAny | None = None
    candidate_meta: CandidateMeta


class PreprocessingIssueResult(BaseModel):
    """1 issue = jsonl の 1 行

    ``issue_excluded`` が指定されている場合 ``candidates`` は空配列でよい (= issue 全体が
    処理失敗)。``candidate_count`` は ``len(candidates)`` の冗長フィールド (見通し用)。
    Node 側実装の将来フィールド追加に備えて ``extra="ignore"``。
    """

    model_config = ConfigDict(extra="ignore")

    id: str | None = None
    issue_excluded: ExclusionReasonAny | None = None
    issue_excluded_detail: str | None = None
    candidates: list[PreprocessingCandidate] = Field(default_factory=lambda: [])
    candidate_count: int = 0
    # gateway error (subprocess 失敗等) で issue 全体が処理できなかった場合は None。
    # それ以外は adapter (Selakovic 等) が必ず付与する。
    issue_meta: IssueMeta | None = None
