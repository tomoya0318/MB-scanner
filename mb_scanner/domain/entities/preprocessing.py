"""Preprocessing (Selakovic データセット前処理) の入出力 Pydantic モデル

Node.js 側 (`mb-analyzer/src/contracts/preprocessing-contracts.ts`) と JSON シリアライ
ゼーション互換を保つ。フィールド名は snake_case、列挙値文字列も両言語で完全一致。

paired-change で更新する: ``mb-analyzer/src/contracts/preprocessing-contracts.ts``。
"""

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class LayoutKind(StrEnum):
    """1 issue ディレクトリの物理レイアウト判定結果

    - ``CLIENT``: ``v_*.html`` 経由 (jsperf benchmark 形式)
    - ``SERVER``: ``<lib>_*/`` ディレクトリ経由 (server / clientServer 系)
    - ``UNKNOWN``: 判定不能
    """

    CLIENT = "client"
    SERVER = "server"
    UNKNOWN = "unknown"


class ExclusionReason(StrEnum):
    """抽出が成立しなかった理由コード

    Phase 4.2 の集計で内訳を取るのに使う。詳細な説明は
    ``mb-analyzer/src/contracts/preprocessing-contracts.ts`` 参照。
    """

    PARSE_ERROR = "parse-error"
    NO_CHANGED_NODES = "no-changed-nodes"
    MODULE_WIDE_CHANGE = "module-wide-change"
    MULTI_FILE_CHANGE = "multi-file-change"
    NO_ENCLOSURE_CANDIDATE = "no-enclosure-candidate"
    LAYOUT_UNKNOWN = "layout-unknown"
    MISSING_FILES = "missing-files"


class PreprocessingInput(BaseModel):
    """Node ランナーへ送る preprocessing 入力 (1 issue 分)

    ``id`` はバッチ API で Python ↔ Node 間の順序暗黙依存を避ける optional マーカー。
    ``issue_dir`` は絶対パスで、Node 側 CLI がファイル読み込み + レイアウト判定を行う。
    """

    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    issue_dir: str


class PreprocessingResult(BaseModel):
    """1 issue 分の抽出結果

    ``excluded`` が指定されている場合 ``slow`` / ``fast`` / ``setup`` は ``None``。
    Node 側実装の将来フィールド追加に備えて ``extra="ignore"``。
    """

    model_config = ConfigDict(extra="ignore")

    id: str | None = None
    layout: LayoutKind
    setup: str | None = None
    slow: str | None = None
    fast: str | None = None
    enclosure_type: str | None = None
    before_node_count: int | None = None
    after_node_count: int | None = None
    excluded: ExclusionReason | None = None
    excluded_detail: str | None = None
