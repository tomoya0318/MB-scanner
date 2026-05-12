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

    集計で内訳を取るのに使う。詳細な説明は
    ``mb-analyzer/src/contracts/preprocessing-contracts.ts`` 参照。
    """

    PARSE_ERROR = "parse-error"
    NO_CHANGED_NODES = "no-changed-nodes"
    MODULE_WIDE_CHANGE = "module-wide-change"
    MULTI_FILE_CHANGE = "multi-file-change"
    NO_ENCLOSURE_CANDIDATE = "no-enclosure-candidate"
    LAYOUT_UNKNOWN = "layout-unknown"
    MISSING_FILES = "missing-files"
    CHANGE_NOT_EXERCISED = "change-not-exercised"


class Aspect(StrEnum):
    """作用点ルーティングの結果 (ADR-0011 §段2) — 実コード変化が *どこ* にあるか

    - ``LIB`` (``"lib"``): ライブラリ (``<lib>_*.js``) のみに実コード変化 — 真 patch は lib の中
    - ``WORKLOAD`` (``"workload"``): ベンチマーク関数 body (``f1.body`` / ``test()`` body) のみに変化
    - ``BOTH`` (``"lib+workload"``): 両方変化 — ADR-0014 の identifier 交差判定で 1 or 2 candidate に分割
    - ``FALLBACK``: どちらにも実コード変化なし / 規約外フォーマット → Tier 1 の素の top-level diff
    """

    LIB = "lib"
    WORKLOAD = "workload"
    BOTH = "lib+workload"
    FALLBACK = "fallback"


class CandidateKind(StrEnum):
    """candidate の役割 / 形

    - ``SINGLE``: split しない既定形 (``aspect: lib`` の embedded / ``aspect: workload`` /
      ``aspect: lib+workload`` の co-evolution / ``fallback``)。``(setup, slow, fast)`` がそのまま 1 セット
    - ``LIB``: ``aspect: lib+workload`` の独立判定で 2 分割したときの lib 側 — lib varies / workload body fixed@before
    - ``BODY``: 同 workload body 側 — workload body varies / lib fixed@before
    - ``CHANGED_FN``: ``aspect: lib`` (lib 内 patch) について、workload が (推移的に) exercise する変更関数を
      1 つ ``<lib>_*.js`` から切り出した pruning 向け candidate (slow/fast = ``__HOLE__`` に変更前/後の
      関数本体 (lambda-lift + 観測する形) + workload、setup = lib 全文 (変更関数だけ穴空き) + 依存 lib + preF1)。
      1 issue で 0〜数個出る — 同 issue の embedded (``SINGLE``) と併存。
    """

    SINGLE = "single"
    LIB = "lib"
    BODY = "body"
    CHANGED_FN = "changed-fn"


class ExecutionEnvironmentHint(StrEnum):
    """preprocess が推奨する等価検証の実行環境 (ADR-0012)

    server / Angular controller-wrapper は ``require`` 解決 / DOM が要るので ``JSDOM``、
    純粋計算の top-level f1 は ``VM``。``equivalence.ExecutionEnvironment`` と値を一致させる。
    """

    VM = "vm"
    JSDOM = "jsdom"


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
    aspect: Aspect | None = None
    candidate_kind: CandidateKind | None = None
    environment: ExecutionEnvironmentHint | None = None
