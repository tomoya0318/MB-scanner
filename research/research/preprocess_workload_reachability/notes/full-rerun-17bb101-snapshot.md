# Selakovic 97 issue 全件再走スナップショット (main @ 17bb101)

<!-- コミット印 (理解モードの一次データ受け入れ条件): -->
- **実行コミット**: `main @ 17bb101` (PR #27 = ADR-0025 server CommonJS strategy merge 直後)
- **dataset**: submodule `selakovic-2016-issues @ 0e73b35` (Cheerio lodash + Mocha shared vendor 追加後)
- **実行日**: 2026-05-27
- **コマンド**: `mise run build-analyzer` → preprocess 全件 → `code/build_equiv_input.py` → equiv batch → `code/build_prune_input.py` → `mbs prune-batch --workers 4 --batch-size 1`。集計は `code/funnel.py`
- **反映済みの設計**: workload-reachability v2 (ADR-0022/0023/0024) + server strategy (ADR-0025)
- **未反映の設計**: ADR-0028 リテラル保護 (実装コミット 0e87134 = PR #28 は 17bb101 より後)。ADR-0028 以降のパイプラインの値が必要な場合は再走すること (論文モード)

## funnel (issue 単位)

- ① 全 issue **97** → ② 真の candidate 抽出済 **96** (excluded 1 = `parse-error`, inline `<script>` が JSX を含む 1 件) → ③④ equiv-input 投入 = verdict 到達 **79 issue (81%)**
- issue 単位 verdict: **`equal` 65 / `not_equal` 9 / `error` 5**

### layout × wrapper_kind (issue 単位、reached / dropped / total)

| layout | wrapper_kind | reached | dropped | total |
|---|---|---:|---:|---:|
| client | top_level | 48 | 7 | 55 |
| client | angular_controller_wrapper | 17 | 8 | 25 |
| server | top_level | 14 | 3 | 17 |

server top_level は旧 baseline (fd4cc92, 順 2-1 時点) の reached 0 / dropped 26 から、順 3-2 (ADR-0025) で reached 14 / dropped 3 に救済された。server issue の母数が 26 → 17 に変わったのは、順 3-2 の detectLayout HTML 優先化で一部が client に再分類されたため。

## candidate 単位

- 抽出 **316** → small-candidate 投入 **113** (equal 84 / not_equal 16 / error 12 / inconclusive 1)
- pruning: equal 84 candidate → **`pruned` 50** / error 33 / initial_mismatch 1。node 削減率は中央値 54% / 平均 48% / 最大 92%
- error 33 件の主因は client big-setup の `$BODY$` 未解決 (`ReferenceError: $BODY$ is not defined` 26 件)。server には非波及 (server は 13/13 全て pruned)

## 関連

- 集計・再走スクリプト: `../code/` (`funnel.py` ほか。論文モードではここから最新契約との整合確認込みで再実行する)
- pruning 段の検証 (段階別 funnel / 論文 10 パターンの形検出 / リテラル保護 ADR-0028 spike): `../../pruning/notes/` (`method.md` / `result.md` / `spike-literal-impact.md`)。主な知見: 形検出は loose 8/8・strict 6/8 (regex≒AST)、リテラル保護で 5/8→6/8。既知の限界は ADR-0028 (繰り返し式の hash 衝突 / 挿入型最適化)
- 旧 Phase 2a スナップショット (`equal` 71/108, ADR-0018 期) は workload-reachability 再設計前のもので superseded
