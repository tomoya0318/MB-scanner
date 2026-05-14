# 0022 preprocess workload-reachability redesign: 移行計画 (v1 → v2)

**目的**: 現ブランチ (`refactor/pruning-common-selakovic-split`) に積み上がった 36 commits を整理して main にマージしてから、placeholder substitution 方式の **v2 を fresh start** で着手する。

**背景**:
- `__HOLE__` 方式 (v1) は spike v1→v2 → 本実装で「動く」ところまで持っていったが、`function-hole.ts` 200 行 + lambda-lift + bootstrap ガード + after-body inline fallback の **3 仕掛けが accidental に複雑** になっている疑念
- Phase 5 で残る `makePromise` error 9 件は `__HOLE__` 経由の sandbox 内 Promise harness 経路に入った副作用の可能性
- **placeholder substitution 方式 (v2)** = setup に `$BODY$` プレースホルダを置いて slow/fast の body を差し込む 4 値契約 `{setup, workload, slow, fast}` の方が本質的にシンプル (lambda-lift 不要、bootstrap-invocation が観測点に化ける、closure で自然に lib 内部依存が見える)
- v1 → v2 の設計進化を **研究の中間成果として main の history に残す**

---

## 全体像

```
[Phase 1] 現ブランチを 1 PR で main へ no-review merge   (整理 0.5 日)
   1 PR: 45 commits + 整理 1 commit = 46 commits
     ← 履歴保存目的、レビューは v2 PR で行う前提で skip
     ← user が CI 通過確認後に self-merge
     ← feature/hydra-pruning ブランチ削除 (内容は v1 PR 経由で main に届く)

[Phase 2] v2 を main から fresh start でしっかりレビュー (4.5-5.5 日 + Angular 2 日)
   feat/preprocess-placeholder-substitution
     ├── D-α: placeholder substitution の spike (1 日)
     ├── D-β: 本実装切り替え (2.5-3.5 日) ← 細かいレビューが効く
     ├── D-γ: DROP 可視化 + 全件再走 + 79 issue 達成 (1 日)
     └── (派生) Angular wrapper 対応 (+ 2 日)
```

**方針の意思決定** (2026-05-13):
前処理を v2 で設計し直す以上、v1 を細分化してレビューしても消える部分が多く時間効率が悪い。1 PR で履歴として main に残し、レビューは v2 PR で実施する方が合理的 (ユーザ判断)。

---

## Phase 1: 1 PR no-review merge

### 現状の 45 commits の内訳 (`main..HEAD` 時系列、古→新)

| # | 範囲 | 内容 |
|---|------|------|
| 1-9 | `269a961..7c6ba91` | hydra pruning エンジン (PR #2/#4/#8/#9/#11 集積、`feature/hydra-pruning` 経由) |
| 10-14 | `62a433d..c137ce4` | preprocess Tier 2 + ADR 0011-0017 + jsdom executor 最小版 |
| 15-16 | `3a3b7be / 51e131c` | preprocessing 4 層 subdir 再編 + コメント規約準拠 |
| 17 | `52870ad` | Merge origin/main into fix/preprocessing-issues |
| 18 | `3da1286` | ADR-0013/0015 accepted + ADR-0016 fork lockfile |
| 19-25 | `eb63683..4d78e7e` | equiv-checker refactor Phase 2b.1-2b.3 |
| 26-34 | `dbddd3a..7ca0037` | equiv-checker refactor Phase A/B/C/D |
| 35-38 | `211284f..c1c29a9` | 雑多 (test in-source / comment cleanup / README docs / docker fix) |
| 39 | `fa18f18` | pruning common/selakovic split |
| 40-45 | `d768ec8..a6b43b6` | preprocess v1 (0022, `__HOLE__` 方式) |

これら 45 commits + **整理 commit 1 つ** = 46 commits を `feat/preprocess-workload-reachability-v1-ground` ブランチに rebase または現ブランチをそのまま使い、main 直結で PR を出して **review なしで self-merge**。

### 整理 commit (= 46 個目、現ブランチに追加)

PR を出す前に、以下を 1 commit にまとめて追加:

1. **`tmp/0022_preprocess-workload-reachability-redesign/` を `research/research/preprocess_workload_reachability/` に移動**
2. **`research/` workspace 立ち上げ** (`research/pyproject.toml` 新規、別 worktree `feat/pruning-analysis` 構造を踏襲)
3. **`ai-guide/adr/0022-preprocess-workload-reachability.md` 起票** (v1 ベースライン、Status `accepted`、最後に「v2 (ADR-0023) で placeholder substitution に置き換え予定」の note)
4. **`ai-guide/adr/0023-preprocess-placeholder-substitution.md` 起票** (proposed、v2 設計の outline、D-α spike 完了時に accepted に昇格予定)
5. **`research/.../code/`** に `_common.py` / `build_equiv_input.py` (rename) / `build_prune_input.py` / `summarize.py` / `inspect_candidates.py` / `scp_to_server.sh` を配置 (内容は tmp 由来をそのまま、import path 修正)
6. **`research/.../reports/v1-summary.md`** に Phase 5 結果清書
7. **`.gitignore`** に `research/research/*/inputs/` を追加

### 作業手順

```bash
# 既に refactor/pruning-common-selakovic-split に居る前提

# 1. 整理 commit を作る
mkdir -p research/research/preprocess_workload_reachability/{code,inputs/v1,reports,notes}
git mv tmp/0022_preprocess-workload-reachability-redesign/plan.md \
       research/research/preprocess_workload_reachability/notes/v1-plan.md
git mv tmp/0022_preprocess-workload-reachability-redesign/notes.md \
       research/research/preprocess_workload_reachability/notes/v1-notes.md
git mv tmp/0022_preprocess-workload-reachability-redesign/prompt.md \
       research/research/preprocess_workload_reachability/notes/v1-prompt-history.md
git mv tmp/0022_preprocess-workload-reachability-redesign/dep-vendoring-tasks.md \
       research/research/preprocess_workload_reachability/notes/dep-vendoring.md
git mv tmp/0022_preprocess-workload-reachability-redesign/migration-plan.md \
       research/research/preprocess_workload_reachability/notes/migration-plan.md
git mv tmp/0022_preprocess-workload-reachability-redesign/refactoring-todo.md \
       research/research/preprocess_workload_reachability/notes/refactoring-todo.md
git mv tmp/0022_preprocess-workload-reachability-redesign/spike-e2e.log \
       research/research/preprocess_workload_reachability/notes/spike-v1.log
git mv tmp/0022_preprocess-workload-reachability-redesign/spike-e2e-v2.log \
       research/research/preprocess_workload_reachability/notes/spike-v2.log
git mv tmp/0022_preprocess-workload-reachability-redesign/build_inputs.py \
       research/research/preprocess_workload_reachability/code/build_equiv_input.py
git mv tmp/0022_preprocess-workload-reachability-redesign/build_prune_input.py \
       research/research/preprocess_workload_reachability/code/build_prune_input.py
git mv tmp/0022_preprocess-workload-reachability-redesign/summarize.py \
       research/research/preprocess_workload_reachability/code/summarize.py
git mv tmp/0022_preprocess-workload-reachability-redesign/inspect_candidates.py \
       research/research/preprocess_workload_reachability/code/inspect_candidates.py
git mv tmp/0022_preprocess-workload-reachability-redesign/scp_to_server.sh \
       research/research/preprocess_workload_reachability/code/scp_to_server.sh
# jsonl_to_json.py は削除 (mise run convert-jsonl task に移行予定 = refactoring-todo)
rm tmp/0022_preprocess-workload-reachability-redesign/jsonl_to_json.py
# inputs (.jsonl/.json) は gitignore に
rm tmp/0022_preprocess-workload-reachability-redesign/*.jsonl tmp/0022_preprocess-workload-reachability-redesign/*.json
rmdir tmp/0022_preprocess-workload-reachability-redesign
# __init__.py を配置
touch research/__init__.py 2>/dev/null
touch research/research/__init__.py
touch research/research/preprocess_workload_reachability/__init__.py
touch research/research/preprocess_workload_reachability/code/__init__.py
# .gitignore に inputs 追加
echo "research/research/*/inputs/" >> .gitignore

# 2. research/pyproject.toml を作成 (別 worktree から踏襲)
cp ../main-feature-hydra-pruning-feat-pruning-analysis/research/pyproject.toml research/pyproject.toml
# (workspace member を含める設定の整合性は要確認)

# 3. v1-summary.md / ADR-0022 / ADR-0023 (proposed) を作成
# (= 内容は notes.md の Phase 5 セクションを清書 + ADR テンプレ流用)

# 4. テスト緑確認
mise run check-arch
mise run lint-analyzer
mise run typecheck
pnpm --filter mb-analyzer test
uv run pytest

# 5. commit
git add -A
git commit -m "docs(research): tmp/0022_ を research/research/preprocess_workload_reachability/ に整理 + ADR-0022/0023 起票"

# 6. PR 作成 (= no-review merge 前提)
gh pr create -R tomoya0318/MB-scanner --base main \
  --title "feat: hydra pruning + equivalence-checker + preprocess workload-reachability v1 (履歴保存目的)" \
  --body-file .github/pr-description-v1.md  # 下記テンプレ
```

### PR description テンプレ

```markdown
## Scope

このPRは以下の作業履歴を main に保存する目的で出している。**コミット単位の細分化レビューは行わず**、self-merge する。

- hydra pruning エンジン (PR #2/#4/#8/#9/#11 集積、`feature/hydra-pruning` 経由 9 commits)
- preprocess Tier 2 化 + ADR 0011-0017 (5 commits)
- equivalence-checker 大規模 refactor (Phase 2b.1-2b.3 / A/B/C/D、16+9 commits)
- pruning common/selakovic 二層分割 (1 commit)
- 0022 preprocess workload-reachability redesign v1 (= `__HOLE__` 方式、6 commits)
- 雑多 (test in-source / comment cleanup / README docs / docker fix、4 commits)
- 研究 dir 整備 (`research/research/preprocess_workload_reachability/` 立ち上げ、ADR-0022/0023 起票、1 commit)

## レビュー方針

v1 の preprocess (`__HOLE__` 方式) は次の PR `feat/preprocess-placeholder-substitution` (= ADR-0023 v2) で **大幅に書き直し予定** (lambda-lift / `if (__HOLE__)` ガード / observe wrapper の 3 仕掛けを placeholder substitution + 4 値契約に簡素化)。書き直し前提なので、本 PR では「動作確認 (= CI 緑) のみ」で通す。

v1 の数字 (extracted 143 / equiv equal 26 / prune pruned 19 / median 削減率 0.174 / 絶対サイズ 75→62 ノード) は中間成果として `research/.../reports/v1-summary.md` に記録。

## 細かいレビューは次の v2 PR で

次の PR (= `feat/preprocess-placeholder-substitution`、ADR-0023) で:
- D-α spike → D-β 本実装 → D-γ DROP 可視化 + 全件再走
- 4 値契約 `{setup, workload, slow, fast}` への切り替え
- AMD 内ローカル / Angular wrapper の扱い

そこで「保持資産 (change-units.ts / reachability.ts / dep-vendoring / argument-mutation fix 等)」も含めて細かくレビューする。

## CI 通過確認

- [x] mise run check-arch
- [x] mise run lint-analyzer
- [x] mise run typecheck
- [x] pnpm --filter mb-analyzer test
- [x] uv run pytest

## v1 PR merge 後の作業

1. `feature/hydra-pruning` ブランチを削除 (内容は本 PR で main に届いた)
2. `feat/preprocess-placeholder-substitution` を main から新規作成 → v2 着手 (= ADR-0023 の D-α spike から)
```

---

### v1 PR merge 後の worktree + ブランチ整理

ユーザ判断に基づく整理対象 (2026-05-13 確定):

| worktree / branch | 処遇 | 理由 |
|-------------------|------|------|
| `main/` | ❌ **保持** | 安定ブランチ |
| `main-feature-hydra-pruning/` (`feature/hydra-pruning`) | ✅ **削除** | 内容は v1 PR で main に届いた |
| `main-feature-hydra-pruning-feat-hydra-pruning-integration-feat-sandbox-undefined-stub/` (`feat/sandbox-undefined-stub`) | ✅ **削除** | 包含済 or 不要 (ユーザ判断) |
| `main-feature-hydra-pruning-feat-pruning-analysis/` (`feat/pruning-analysis`) | ❌ **保持** | research/ 立ち上げ進行中 (別作業) |
| `main-feature-hydra-pruning-fix-preprocessing-issues/` (現 worktree、`refactor/pruning-common-selakovic-split`) | ✅ **削除** | v1 PR merge 後、役目終了 |
| `main-feature-hydra-pruning-refactor-equivalence-checker-jsdom-vm/` (`refactor/equivalence-checker-jsdom-vm`) | ✅ **削除** | feature/hydra-pruning と完全同期 (独自 commit なし) |
| `main-feature-hydra-pruning-refactor-equivalence-checker-playwright/` (`refactor/equivalence-checker-playwright`) | ✅ **削除** | ADR-0012 で playwright fallback 確定済、spike 役目終了 |

**整理コマンド** (v1 PR merge 後、`main/` worktree から実行):

```bash
cd /Users/tomoya-n/dev/research/MB-scanner/main

# 各 worktree を削除 (現 worktree から離れてから)
git worktree remove ../main-feature-hydra-pruning
git worktree remove ../main-feature-hydra-pruning-feat-hydra-pruning-integration-feat-sandbox-undefined-stub
git worktree remove ../main-feature-hydra-pruning-fix-preprocessing-issues
git worktree remove ../main-feature-hydra-pruning-refactor-equivalence-checker-jsdom-vm
git worktree remove ../main-feature-hydra-pruning-refactor-equivalence-checker-playwright

# ローカルブランチ削除
git branch -D feature/hydra-pruning
git branch -D feat/sandbox-undefined-stub
git branch -D refactor/pruning-common-selakovic-split
git branch -D refactor/equivalence-checker-jsdom-vm
git branch -D refactor/equivalence-checker-playwright

# remote ブランチ削除 (= GitHub に push されているものを削除)
git push origin --delete feature/hydra-pruning           || true
git push origin --delete feat/sandbox-undefined-stub      || true
git push origin --delete refactor/pruning-common-selakovic-split  || true
git push origin --delete refactor/equivalence-checker-jsdom-vm    || true
git push origin --delete refactor/equivalence-checker-playwright  || true

# worktree 一覧で確認 (main + feat/pruning-analysis の 2 つだけが残るはず)
git worktree list
```

### v2 用 worktree 作成 (整理後)

```bash
cd /Users/tomoya-n/dev/research/MB-scanner/main
git pull origin main   # v1 PR 反映を取り込む

# v2 用 worktree を新規作成
git worktree add ../main-feature-preprocess-placeholder-substitution -b feat/preprocess-placeholder-substitution main

cd ../main-feature-preprocess-placeholder-substitution
pnpm --filter mb-analyzer install
git submodule update --init --recursive
```

これで v2 worktree から `D-α spike` 着手。

---

## Phase 2: v2 fresh start (placeholder substitution)

**branch**: `feat/preprocess-placeholder-substitution`
**base**: `main` (Phase 1 完了後の状態)
**前提**: PR-3 が main に入っているので、保持資産 (change-units.ts / reachability.ts / argument-mutation fix / dep-vendoring / ADR 更新等) は全て main にある状態でスタート

### 設計の核 (v2 = 4 値契約)

```
setup     = lib ($BODY$ プレースホルダ含む) + dep + preF1
workload  = 観測 hook (= 変更関数を上書きして戻り値を __OBS に push) + f1 body
slow      = before の関数本体 statement 列のみ (workload 含まない)
fast      = after  の関数本体 statement 列のみ
```

executor (jsdom / vm 共通):
```typescript
const finalProgram = options.setup.replace('$BODY$', options.body) + ';\n' + options.workload;
vm.runInContext(finalProgram, context, { timeout: ... });
```

旧契約 (= `workload` フィールドなし) は **後方互換**: 現状の 2 回 runInContext モデルで動かす (lib-embedded `single` / `lib` / `body` / fallback 用)。

### D-α: spike (1 日) — **完了 (2026-05-13、約 1.5 時間で success 判定)**

**結果**: `notes/spike-v3.log` 参照。14 tests 全件緑、success 判定。クリーンケース 4 件すべて中身のある equal、Ember 3174/4329_1 も bootstrap-invocation 込みで equal 相当 (v1 の argument_mutation oracle error が body 観測注入で解消する可能性が示唆された)。

**設計の進化**: ADR-0023 の元案「workload 側で observe hook (`<accessName> = function () {...}`) を立てる」は **AMD/IIFE 内ローカル名** (`_s.startsWith` 等、bootstrap 後の global からは `_.str.startsWith` でしか到達できない) で ReferenceError or 別オブジェクト代入になる限界が判明。代わりに **body 内部に観測ラッパ (`var __r = (function () { ... }).call(this); __OBS.push(...); return __r;`) を注入する** 形に修正 = `mb-analyzer/src/preprocessing/common/placeholder.ts` の `wrapBodyObserved`。これで access name resolution 不要、AMD/IIFE 内ローカルにも強い汎用設計に。

**目的**: placeholder substitution 方式が `__HOLE__` 方式と同等以上の動作を 12 issue で示すか実証。

**ファイル**: `mb-analyzer/tests/preprocessing/spike-placeholder.test.ts` (新規、git untracked、実証完了後 = D-β 完了後に削除)、`mb-analyzer/src/preprocessing/common/placeholder.ts` (新規、D-β で本実装に流用予定)

**対象 12 issue** (spike v2 と同じ):
- クリーンケース: Underscore.string 347_1 / 347_2、jQuery 367、Underscore 1222
- Ember 級: 3174 (`Ember.assert`)、5547 (`set` over-observation)、4329_1 (`cacheFor`)、4158 (`guidFor`)、4263、9991
- 残: Underscore 1223 (`_.forEach`)、jQuery 248 (`fn.html`)

**判定基準**:
| カテゴリ | 期待 |
|---------|------|
| クリーンケース 4 件 | `__HOLE__` 方式と同じく「中身のある equal + slow/fast の差分が観測」or「同じ動作なら equal で `__OBS` 一致」 |
| Ember bootstrap-invocation (3174 / 1223) | placeholder model なら **bootstrap 中も差し替え版が走るので観測点が増える**、本物の patch なら差が出るのが正解 |
| AMD 内ローカル系 (5547 / 4329_1 等) | observe hook が `_s.foo = ...` 形でなく AMD `define(...)` 内ローカル名の場合は捕捉できない可能性 = **placeholder model の限界**として可視化 |
| param 不一致 / arrow body | 現状と同じく candidate 不可で skip |

**判定**:
- **(success)** = クリーンケース 4 件 + Ember 一部で「中身のある equal」 → D-β 進む
- **(partial)** = クリーンケース OK だが Ember 級が AMD 内ローカル問題で詰む → hybrid (= AMD 系だけ `__HOLE__` を残す) を検討
- **(fail)** = クリーンケースも observe `[]` のまま / bootstrap 壊れる → 撤退、v1 (`__HOLE__` 方式) のままで研究を閉じる

**撤退条件のための工数限界**: D-α で 1 日 × 1.5 倍 (= 1.5 日) を超えたら一旦止めて再評価。

### D-β: 本実装切り替え (2.5-3.5 日)

D-α が success なら以下を一気に書き直す:

| ファイル | 変更 |
|----------|------|
| `mb-analyzer/src/contracts/preprocessing-contracts.ts` | `PreprocessingResult.workload?: string` 追加 |
| `mb-analyzer/src/contracts/equivalence-contracts.ts` (or 同等) | `EquivalenceInput.workload?: string` 追加 |
| `mb-analyzer/src/contracts/pruning-contracts.ts` | `PruningInput.workload?: string` 追加 |
| `mb_scanner/domain/entities/preprocessing.py` | paired-change (`workload: str \| None`) |
| `mb_scanner/domain/entities/equivalence.py` | paired-change |
| `mb_scanner/domain/entities/pruning.py` | paired-change |
| `mb-analyzer/src/preprocessing/common/function-hole.ts` | **大幅縮減**: `liftableNames` / `pickLiftedDeps` / `holeLibSource` / `buildHoleFunction` を削除 (or `placeholder.ts` 新規 + 旧削除)、`paramNames` / `functionBlockBody` / `countSubtreeNodes` は残す |
| `mb-analyzer/src/preprocessing/common/placeholder.ts` (新規 or function-hole.ts 改題) | `replaceBodyWithPlaceholder` / `resolveAccessName` / `buildObserveHook` / `wrapObservedWorkload` |
| `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts` | **書き直し**: 4 値 (`setup`/`workload`/`slow`/`fast`) を出力 |
| `mb-analyzer/src/equivalence-checker/common/sandbox/executors/jsdom.ts` | **無改修** (= 2 引数 API のまま、setup state snapshot 機構を維持) |
| `mb-analyzer/src/equivalence-checker/common/sandbox/executors/vm.ts` | 同 |
| `mb-analyzer/src/preprocessing/selakovic/pipeline.ts` (or 呼び出し側) | 4 値契約を 2 引数に展開する経路を追加 (= `workload !== undefined` のとき `executor({ setup: substituteBody(originalSetup, slow/fast), body: workload })` を 2 回呼ぶ) |
| `mb-analyzer/tests/preprocessing/selakovic.test.ts` | changed-fn 関連 assertion を 4 値に書き直し |
| `tests/domain/entities/test_preprocessing.py` / `test_equivalence.py` / `test_pruning.py` | `workload` round-trip テスト追加 |
| `ai-guide/adr/0024-preprocess-placeholder-substitution.md` | **新規起票** |
| `ai-guide/adr/0022-preprocess-workload-reachability.md` | Status を `accepted, superseded by 0024` に更新 |

**テスト**: 全 vitest + uv run pytest + mise run check-arch を緑に。

#### D-β 着手前に議論必須 (= 着手前に決め、結果を ADR に書く)

- **`CANDIDATE_KIND` の再設計**: 現状 `single` / `lib` / `body` / `changed-fn` の 4 値がフラットに並んでいるが、preprocess の目的論は **「`changed-fn` を抜き出すこと」が主、`single`/`lib`/`body` は `changed-fn` が出せない経路の fallback embedded** という階層構造になっている (v2 でこの階層が顕在化)。
  - 現状の `CANDIDATE_KIND` docstring (`preprocessing-contracts.ts:62-66`) は `__HOLE__` 言及があり、いずれにせよ書き直し必要
  - **議論する案** (D-β 着手前に決める):
    - **案 X (現状維持、後方互換)**: 列挙値そのまま、`workload?` フィールドだけ追加。docstring を v2 (placeholder substitution、body 観測注入) に書き直す。paired-change 最小。
    - **案 Y (主役 / fallback で再分類)**: `CHANGED_FN` (主役) + `EMBEDDED_FALLBACK` (= 旧 `single`/`lib`/`body` 統合) の 2 値に縮約、ASPECT × SPLIT_KIND 等で副情報を別フィールドに分離。目的論が型から読める。contracts 変更大、ADR-0014 / 0022 との関係整理が必要。
    - **案 Z (階層化)**: `CHANGED_FN` + `EMBEDDED` の 2 値 + 別フィールドに `split_kind: single | lib | body`。直交軸を分離。組み合わせ爆発なし。
  - 案 Y / Z を取るなら **新規 ADR-0024 を起票** (= ADR-0023 とは別軸の決定)、ADR-0014 (case-split for both-changed) と ADR-0022 (`__HOLE__` 方式) の参照関係も整理。案 X なら ADR は ADR-0023 だけで足りる。

### D-γ: DROP 可視化 + 全件再走 + 79 issue 達成確認 (1 日)

**DROP 可視化** (元の案 D):
- `pipeline.ts:appendChangedFnCandidates` の 5 経路 (`parse-fail / empty-diff / no-fn-unit / change-not-exercised / builder-null`) に `EXCLUSION_REASON` を当てて `excluded` レコードを `candidates` に push
- 集計可能になる

**全件再走** (brain-2 docker):
1. dist 再 build
2. preprocess-selakovic-batch (--dataset デフォルト or 引数)
3. equiv → prune まで
4. `research/.../code/summarize.py` で 0019/0021/0022-v1/0022-v2 の reduction rate 比較表

**達成確認**: `server (17) + fallback (1) を除く 79 issue` で `body or changed-fn` が ≥ 1 件出るか集計。

**`research/.../reports/comparison.md`** を清書:
- v1 (`__HOLE__` 方式) の Phase 5 数字 と v2 (placeholder substitution) の数字を並べる
- error 内訳の差 (特に `makePromise` 9 件が消えたか)
- pruning の reduction rate / 絶対サイズ

### (派生) Angular wrapper 対応 (+ 2 日)

別 TODO #8 を spike D 完了後の続編として実装:
- `extractF1` で wrapperKind=`angular-controller-wrapper` の場合、controller body の f1 を decompose してから placeholder candidate を組む
- `$scope` / DI / bootstrap の扱いをどう placeholder model に乗せるかが非自明 → 別途 spike が要る可能性

26 issue 救えれば 79 → 79+26=実質達成率向上、ただし Angular wrapper の lambda-lift も同じ AMD 内ローカル問題に遭う可能性あり (= Angular の controller scope は IIFE と等価で AMD と類似)。Phase D-γ で見えた数字次第。

---

## 保持資産と置き換え対象の切り分け

### 保持 (Phase 1 で main に入る、v2 でも再利用)

- `mb-analyzer/src/preprocessing/common/change-units.ts` ← findChangeUnits / fn unit / stmt unit (設計非依存)
- `mb-analyzer/src/preprocessing/common/reachability.ts` ← workload-reachability の call graph (設計非依存)
- `mb-analyzer/src/preprocessing/selakovic/io/script-deps.ts` ← dep-vendoring (`<script src>` 解決)
- `mb-analyzer/src/equivalence-checker/common/comparison/oracles/argument-mutation.ts` (unserializable fix) ← Ember 系の循環参照対策
- `mb-analyzer/src/ast/parser.ts` (`GenerateOptions { comments?: boolean }`)
- `mb-analyzer/src/preprocessing/common/setup-cleanup.ts` (`statementsToCode` の `comments: false`)
- `data/selakovic-2016-issues` submodule pointer (fork の jquery 1.7 swap + 各 issue の package.json/pnpm-lock.yaml override)
- ADR-0011 / 0014 / 0018 の 2026-05-12 更新

### 置き換え (v2 で削除 or 大幅縮減)

- `mb-analyzer/src/preprocessing/common/function-hole.ts` (lambda-lift / `__HOLE__` 系 = 200 行のうち 150 行以上削除)
- `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts` (書き直し)
- `mb-analyzer/tests/preprocessing/selakovic.test.ts` の changed-fn 関連 assertion (書き直し)
- ADR-0022 (Status を `superseded by 0024` に)

---

## リスクと撤退条件

| リスク | 対応 |
|--------|------|
| PR-1 (22 commits) が review で詰まる | PR description で「sandbox 二層化 / oracle 拡充 / 保守化 verdict」の 3 軸に分解して説明、レビュアが見やすいよう commit を文脈ごとにグループ化 |
| PR-2 で cherry-pick がコンフリクト | PR-1 を main 取り込み後に rebase、衝突箇所は手動解決 (主に pruning ディレクトリ) |
| PR-3 で extracted.jsonl 等の大ファイルが git に入る | `.gitignore` で `research/.../inputs/` を除外、commit 前に確認 |
| feature/hydra-pruning 削除の前に他作業が乗っていた | 削除前に `git log feature/hydra-pruning ^main` で確認、もし 1 commit (`abb05b8`) 以外があれば一旦保留 |
| D-α で AMD 内ローカル問題が拭えない (= partial) | hybrid 案 (= `_s.foo = ...` 形のみ placeholder、AMD 内ローカルは `__HOLE__` を残す) を検討、または「AMD 内ローカルは設計対象外」と認めて 79 達成数字を訂正 |
| D-α が fail (撤退) | v1 のまま研究を閉じる、`comparison.md` に「placeholder 検討したが Selakovic 級では不採用」と記録、ADR-0024 は status `rejected` |

---

## 工数見積もり

| Phase | 工数 |
|-------|------|
| **Phase 1 整理** (3 PR + review 時間含まず) | **2-3 日** |
| Phase 2 D-α (spike) | 1 日 |
| Phase 2 D-β (本実装) | 2.5-3.5 日 |
| Phase 2 D-γ (DROP 可視化 + 全件再走) | 1 日 |
| Phase 2 派生 Angular | + 2 日 |
| **合計** | **6.5-9.5 日** (Angular 込み 8.5-11.5 日) |

review 時間を含めると **2-3 週間** 程度のスパン。

---

## 関連参照

- 現状 v1 の plan: `tmp/0022_preprocess-workload-reachability-redesign/plan.md`
- 現状 v1 の notes (Phase 0.5 / 5 の記録): `tmp/0022_preprocess-workload-reachability-redesign/notes.md`
- 案 B/C の deferred TODO: `tmp/0022_preprocess-workload-reachability-redesign/refactoring-todo.md` (本 PR で起票)
- 別 worktree の research/ 構造参照元: `../main-feature-hydra-pruning-feat-pruning-analysis/research/`
