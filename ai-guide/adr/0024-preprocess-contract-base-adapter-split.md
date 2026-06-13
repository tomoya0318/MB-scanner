# ADR-0024: preprocess contract を base / adapter 分離 + issue 階層化に再設計する

- **Status**: accepted (議論で合意済 — `tmp/0001_candidate-kind-redesign-discussion/plan.md` §X-1)
- **Date**: 2026-05-15
- **Related**: ADR-0010 (enclosure 3 段, `enclosure_node_type` の起源), ADR-0011 (Tier 構造 + `aspect` 導入), ADR-0014 (case-split + `candidate_kind` 導入), ADR-0015 (equivalence-checker layering + DOM oracle), ADR-0022 (workload-reachability + `changed-fn` 追加), ADR-0023 (placeholder substitution v2、本 ADR と並走で `workload?` フィールドを追加予定), `tmp/0001_candidate-kind-redesign-discussion/plan.md`

## コンテキスト

ADR-0011 (`aspect` 導入) → ADR-0014 (`candidate_kind` の `single`/`lib`/`body` 追加) → ADR-0022 (`candidate_kind: changed-fn` 追加) と段階的に成長してきた preprocess 出力 contract が、以下の問題を抱えている:

1. **`candidate_kind` は本来「同 issue 内で複数 candidate が出るときの付番」として導入された** (ADR-0014/0022 文面、`tmp/0001_*/plan.md` §G)。理論的概念分節ではなく、aspect で routing した結果出力の役割を後段から区別するためのタグ。aspect と部分的に意味重複 (kind の `lib`/`body` と aspect の `lib`/`workload` の語彙衝突)。
2. **`enclosure_type` は 2 責務同居**: ADR-0010 起源は「changed_nodes を内包する最小 enclosure の Babel ノード型名」(集計 hint)。ADR-0011 で `lib-file` / `f1-body` / `lib-file+f1-body` / `angular-controller-wrapper` / `server-test-case` という assemble 経路名 (戦略ラベル) が暗黙拡張で混入し、現在は「構造ラベル」と「戦略ラベル」が同居 (`tmp/0001_*/plan.md` §N)。
3. **後段は contract hint を branch に使っていない**: `equivalence-checker/` 配下を grep すると `aspect` / `candidate_kind` / `enclosure_type` の参照ゼロ。pruning も pass-through のみ。oracle 選択は `oracle-routing.ts:30-32` の `environment` 1 軸で完結し、ADR-0015 で並記された「hint で oracle 部分集合を選ぶ」案は同 ADR の「N/A 自己判定で over-list は verdict 不変」補強で実質的に却下されている (`tmp/0001_*/plan.md` §H, §S)。
4. **メタ情報が同 issue の複数 candidate で重複表現される**: ADR-0014 の independent split で 2 candidate が出るとき、`aspect` / `layout` / `wrapper_kind` 相当が両方の row に同じ値で書かれる (= jsonl の冗長)。
5. **dataset 固有概念が base contract に混入**: `aspect` (lib_*.js / f1.body の二分法) も `layout` (HTML benchmark の client/server 分離) も `candidate_kind` (A+B split / changed-fn 抽出戦略) も、Selakovic 2016 dataset の構造に依存している。base contract に置くと将来別 dataset を追加するとき contract そのものを編集する paired-change が必要になる。

これら 5 つを同時に解消するため、preprocess 出力の物理構造を **base / adapter 分離 + issue 階層化** に再設計する。

## 選択肢

- **A. 現状維持 (rename/docstring 整理のみ)**: enum 値の rename と ADR への役割表追記で済ませる。kind/enclosure_type は残す。
- **B. kind 全廃 + flat 維持**: `candidate_kind` を削除し、必要情報を adapter フィールドに統合する。物理構造は 1 row = 1 candidate のまま。
- **C. kind 全廃 + base/adapter 分離 + issue 階層化 (= 本 ADR の採用案)**: contract を「common (dataset 非依存)」と「adapter (Selakovic 固有)」に物理分離。jsonl は 1 row = 1 issue + `candidates: list` の階層化。
- **D. kind 全廃 + base/adapter 分離 + コードも階層共有 (= H-β2)**: C に加えて、同 issue の candidate 間で共有される setup/lib コード断片も物理的に共有参照する形。

### 評価

| 軸 | A | B | C (採用) | D |
|----|---|---|---|---|
| 意味重複の解消 | △ docstring 整理のみ | ○ kind 削除 | **◎ 4 系統 (kind/enclosure/メタ重複/dataset 混入)** | ◎ |
| 後段 dead hint の整理 | × | ○ | ○ | ○ |
| 新 dataset 追加時の paired-change | ✗ contract 編集要 | ✗ 同左 | **◎ adapter 追加のみ** | ◎ |
| jsonl サイズ縮小 | × | × | △ メタのみ | ◎ コードも |
| equivalence-checker 入力との整合 | ◎ 無改修 | ◎ 無改修 | ○ flatten 1 段 | ✗ 組み立てロジック新設 |
| migration コスト | 0 | 中 | **中** | 大 |
| 「issue / candidate のレベル感」の明示性 | × | × | **◎ 物理構造に反映** | ◎ |
| 集計の書きやすさ | × 旧 SMALL_KINDS のような暗黙約束に依存 | △ flat だが意味カテゴリは綺麗 | **◎ issue 単位 / candidate 単位で素直に書ける** | ◎ |

## 決定

**C (kind 全廃 + base/adapter 分離 + issue 階層化)** を採用する。

主要な根拠:
- 5 系統の問題 (kind 重複 / enclosure_type 不純 / hint dead / メタ重複 / dataset 混入) を同時に解消する単一の構造変更
- D まで踏み込まなくても、メタ重複の解消で「issue / candidate のレベル感」は表現できる。コード重複削減 (D) は jsonl サイズが Ember 級 extreme ケース以外では問題化しないので後回し可
- equivalence-checker の oracle 選択が `environment` 1 軸で完結するため、preprocess 由来 hint (aspect / kind / enclosure_type) を契約から削除しても verdict は不変 (= ADR-0015 の N/A 自己判定方針と整合)

### 確定する設計

#### 物理レイアウト (Pydantic、TS は paired-change)

```python
# === Common (dataset 非依存) ===
class PreprocessingCandidate(BaseModel):
    """1 candidate の出力 (equivalence-checker の入力単位)。"""
    setup: str | None = None
    slow: str | None = None
    fast: str | None = None
    before_node_count: int | None = None
    after_node_count: int | None = None
    enclosure_node_type: str | None = None       # 抽出した最小 enclosure の AST ノード型名
    candidate_excluded: ExclusionReasonAny | None = None
    candidate_meta: CandidateMeta                # discriminated union (adapter 拡張)

class PreprocessingIssueResult(BaseModel):
    """1 issue = jsonl の 1 行。"""
    id: str | None = None
    issue_excluded: ExclusionReasonAny | None = None
    issue_excluded_detail: str | None = None
    candidates: list[PreprocessingCandidate] = []
    candidate_count: int = 0                      # = len(candidates)、見通し用
    issue_meta: IssueMeta                         # discriminated union (adapter 拡張)

ExclusionReasonAny = ExclusionReasonBase | SelakovicExclusionReason

class ExclusionReasonBase(str, Enum):  # common 4 値
    PARSE_ERROR = "parse-error"
    NO_CHANGED_NODES = "no-changed-nodes"
    MULTI_FILE_CHANGE = "multi-file-change"
    MISSING_FILES = "missing-files"

# === Selakovic adapter (dataset 固有) ===
class SelakovicCandidateMeta(BaseModel):
    adapter: Literal["selakovic"] = "selakovic"
    target_side: TargetSide          # lib / workload / both (candidate level)
    is_workload_reachable: bool      # changed_fn 抽出由来か

class SelakovicIssueMeta(BaseModel):
    adapter: Literal["selakovic"] = "selakovic"
    layout: LayoutKind               # client / server / unknown
    aspect: Aspect                   # lib / workload / lib+workload / fallback (issue level)
    wrapper_kind: WrapperKind        # top_level / angular_controller_wrapper

class SelakovicExclusionReason(str, Enum):  # Selakovic 固有 4 値
    MODULE_WIDE_CHANGE = "module-wide-change"
    NO_ENCLOSURE_CANDIDATE = "no-enclosure-candidate"
    LAYOUT_UNKNOWN = "layout-unknown"
    CHANGE_NOT_EXERCISED = "change-not-exercised"

CandidateMeta = Annotated[SelakovicCandidateMeta, Field(discriminator="adapter")]
IssueMeta = Annotated[SelakovicIssueMeta, Field(discriminator="adapter")]
```

新 dataset を追加するときは `SelakovicXxx` と並ぶ新 sub-class を足し、`CandidateMeta` / `IssueMeta` の Union に追加する。base contract と base enum は触らない。

#### `candidate_kind` の代替

旧 `candidate_kind` は廃止し、(a) **issue level の `aspect`** + (b) **candidate level の `target_side` + `is_workload_reachable`** の組合せで再構成する。aspect と target_side は同じ `lib`/`workload` 語彙を使うが、aspect は元 patch がどこにあるか (1 issue = 1 値)、target_side は出力候補がどっち側を表現するか (1 candidate = 1 値) と **レベル感が違う**ことを物理構造で明示する。

#### `enclosure_type` の代替

旧 `enclosure_type` の 2 責務を分割:
- 「assemble 経路名」(`lib-file` / `f1-body` / `lib-file+f1-body` / `server-test-case` / `angular-controller-wrapper`) は **削除**。`(aspect, target_side, layout, wrapper_kind)` から派生可能。
- 「Babel ノード型名」(`FunctionExpression` 等) は **`enclosure_node_type` として base contract に分離**。changed_fn / fallback でのみ意味を持つ optional フィールド。

#### oracle 選択 hint の廃止

`EquivalenceInput` / `PruningInput` の `aspect` / `candidate_kind` / `enclosure_type` 3 フィールドは削除。oracle 選択は `equivalence-checker/selakovic/oracle-routing.ts` の `environment` (vm / jsdom) 1 軸で完結する設計を ADR-0015 の正式裁定として確定 (= 並記されていた「hint で部分集合を選ぶ」案は不採用と確定)。`environment` は preprocess contract には残さず、selakovic adapter (`research/.../code/build_equiv_input.py:derive_environment`) が引き当てる: **現状は常に `jsdom`** (server candidate も `require`/Node globals を jsdom executor の shim で解決する前提、`oracle-routing.ts` line 6 / `assemble/server.ts` 参照)。VM executor が server contract をサポートする実装が入った時点で layout 別の派生に変更する。

#### assemble 関数の組織 (実装側)

`assemble/` 配下を 2 軸で組み直す:
- `assemble/wrappers/<wrapper>.ts`: wrapper_kind 軸 (top-level / angular / 将来)
- `assemble/strategies/<strategy>.ts`: 抽出戦略軸 (embedded / changed-fn / raw-stmt)

新 dataset で別 wrapper / 別 strategy が増えても、各ディレクトリに追加するだけ。

## 結果 / 影響

### 得るもの

- 後段から見た hint contract が縮む (`EquivalenceInput` / `PruningInput` から 3 フィールド削除)。dead code 削除。
- 新 dataset 追加時に base contract と base enum を触らずに adapter sub-class 1 ペアを足すだけで済む (= paired-change が adapter に閉じる)
- 集計コードが意味カテゴリで直接フィルタできる (旧 `SMALL_KINDS = {"changed-fn", "body"}` のような暗黙約束 → `is_workload_reachable or target_side == "workload"`)
- jsonl 1 行 = 1 issue で issue 単位の集計が直線的、`candidate_count` で「同 issue から何 candidate 出たか」が一目で分かる
- `aspect` の "lib" と `target_side` の "lib" の名前空間衝突が「issue level / candidate level」の物理分離で解消

### 諦めるもの・将来のコスト

- **brain-2 既存 `extracted.jsonl` (143 件) との互換**: 物理構造が flat → 階層化、フィールド名も変わる → 旧 jsonl から新スキーマへの migration script が必要。トリガー: 過去結果の再現性が必要になった時点で着手。`enclosure_node_type` は v1 から既に出ているので derived view で v1 集計値の大半は再現可能 (`tmp/0001_*/plan.md` §J-4 と同じ手口)。
- **independent split のペア識別**: candidate level だけ見ると `target_side=lib` の candidate と `target_side=workload` の candidate がペアか単独かを判別不能。`(issue.aspect == "lib+workload", candidate_count == 2)` で issue level から識別する規約を集計側に置く必要。
- **fallback の `target_side` 値**: 実装で `both` に確定 (`assemble/fallback.ts` で `TARGET_SIDE.BOTH` を hardcode)。fallback は lib/workload 両方の patch を含みうる top-level statement diff のため、どちらか片側に寄せる根拠がない。集計上 `target_side == "lib"` / `"workload"` のフィルタからは除外され、fallback 専用の集計が要るなら `aspect == "fallback"` で見る。
- **`workload?: string` フィールド (ADR-0023 D-β 由来) の配置**: 本 ADR 起票時点では未決定。ADR-0023 D-β マージ後に `PreprocessingCandidate` の base に optional フィールドとして追加し、本 ADR 末尾に「§更新」で確定する想定。
- **将来 oracle 切り替えが必要になった場合**: hint 廃止により、aspect/kind ベースで oracle 部分集合を選ぶ実装は contract レベルではできなくなる。代替: selakovic adapter 内で `(aspect, target_side, layout, wrapper_kind)` から oracle subset / 正規化プロファイルを引く lookup table を持つ。ADR-0015 の DOM 正規化プロファイル分岐トリガー発火時点でこの設計を具体化。

### migration / 影響範囲

- TS contracts: `mb-analyzer/src/contracts/{preprocessing,equivalence,pruning}-contracts.ts`
- Python entities: `mb_scanner/src/mb_scanner/domain/entities/{preprocessing,equivalence,pruning}.py`
- TS preprocess: `mb-analyzer/src/preprocessing/selakovic/pipeline.ts`、`assemble/{client,changed-fn,fallback,server,angular}.ts` (assemble の組織変更込み)
- TS equivalence-checker / pruner: `cli/check-equivalence.ts`, `cli/prune.ts` の `RESERVED_FIELDS` から hint フィールド削除、`pruning/selakovic/pruner.ts:20-22` の closure 詰め直し削除
- research script: `research/research/preprocess_workload_reachability/code/{build_equiv_input,build_prune_input,summarize,inspect_candidates}.py` のフィルタ・集計 key 書き換え
- README: `mb-analyzer/src/equivalence-checker/README.md` の「`aspect` / `candidate_kind` / `enclosure_type` hint」記述を削除 or 「派生で持つ」に書き換え
- 過去 ADR (0011 / 0014 / 0015 / 0022 / 0023): 末尾に「§更新 2026-05-15: 本 ADR (0024) で再設計」一行追記

実装は **本 ADR ブランチを D-β 本体より先に main マージする前提** で進める (本ブランチで preprocess / equiv / pruning contract の構造変更を完結させ、D-β 本体側で rebase + `workload?` フィールドを追加)。同じ contract ファイル群を編集するため、逆順 (D-β 本体先) だと本 ADR 実装ブランチが大規模 rebase を被る。

## トリガー (再検討の条件)

- 新 dataset を追加した際に base contract / base enum にも変更が必要になったとき → 「common = dataset 非依存」の定義を見直す
- equivalence-checker 側で oracle 部分集合を hint から選ぶ実装が必要になったとき → 廃止した hint を adapter_meta から派生計算する lookup を equiv adapter に追加 (本 ADR の決定は変えない、adapter 内で派生する形)
- jsonl サイズが Ember 級 extreme ケース以外でも実用上の問題になったとき → 案 D (コード共有参照) の再検討
- `target_side` / `is_workload_reachable` で表現できない新しい抽出戦略が dataset 拡張で必要になったとき → adapter sub-class にフィールド追加 or 新 enum 値追加で吸収可能か検討、不可なら本 ADR 再設計
- ADR-0023 D-β で追加される `workload?: string` の配置を本 ADR 末尾に確定する (= 末尾追記イベント)

## 補足

- 議論経緯と検討した代替案の詳細は `tmp/0001_candidate-kind-redesign-discussion/plan.md` 全体を参照。特に §C-§D (kind の起源) / §I (現実生成経路の組合せ表) / §Q (フィールド意味重複の洗い出し) / §S (oracle hint 不要の実証) / §V-§Z (base/adapter 分離の段階的整理) が本 ADR の根拠。
- ADR-0023 D-β との実装順序判断は本セッションでは保留。実装着手前に再決定する想定。

## §更新: 2026-05-18 — `workload?: string` を `PreprocessingCandidate` base に配置 (ADR-0023 D-β 確定)

ADR-0023 D-β の placeholder substitution + 4 値契約マージに伴い、本 ADR §諦めるもの「`workload?: string` フィールドの配置」を確定する:

- **配置**: `PreprocessingCandidate` (base) に `workload?: string` を optional 追加。`EquivalenceInput` / `PruningInput` にも同名 optional フィールドで paired (TS は `workload?: string`、Python は `workload: str | None = Field(default=None, max_length=MAX_CODE_LENGTH)`)
- **根拠**: changed-fn 経路のみ非 None だが、「workload 文字列を持つ」という構造は dataset 非依存の placeholder substitution model の構成要素 (= base に置ける一般概念)。adapter sub-class に押し下げると別 dataset でも同じ手法を使う際に再宣言が要る
- **経路判別**: TS `input.workload != null` (loose) / Python `input.workload is not None`。null と undefined の両方を旧経路扱いに統一 (Python `model_dump()` は null を JSON に乗せるので、TS は loose 比較が必須)
- **対称な空欄**: `is_workload_reachable=false` の candidate (旧経路 / change-not-exercised marker) は `workload === undefined`。adapter_meta で別途 `is_workload_reachable` を持つので、`workload` 有無と完全には連動しない (excluded marker は両方 false / undefined)
- **実装範囲**: PR #18 (contracts paired-change + 汎用 AST helper 集約) で base への追加は完了。本 §更新 は ADR 末尾追記のみ。実装の影響範囲は ADR-0023 D-β Phase 1〜6 にすべて記載
