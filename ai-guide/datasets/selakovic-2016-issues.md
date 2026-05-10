# Selakovic 2016: JavaScript Performance Issues Dataset

等価性検証器 (`mbs check-equivalence`) の評価に利用する従来研究データセット。98 件の JS パフォーマンス改善 PR を収集したもの。

- 出典: Selakovic & Pradel, "Performance issues and optimizations in JavaScript: an empirical study" (ICSE 2016)
- 一次配布元: https://github.com/marijaselakovic/JavaScriptIssuesStudy (論文著者 repo)
- submodule 参照先: https://github.com/tomoya0318/selakovic-2016-issues (`marijaselakovic/JavaScriptIssuesStudy` の fork。`data/selakovic-2016-issues/` と repo 名を揃え、上流が消えた場合の評価再現性を担保するため)
- ライセンス: **repo に記載なし**。引用ベースの研究利用は慣行上問題ないが、派生データセットを再配布する場合は著者に要確認。

## 配置

```
data/selakovic-2016-issues/   # git submodule として登録済み (.gitmodules + .gitignore 例外)
```

**git submodule 方式**を採用している理由:
- commit SHA が `.gitmodules` + submodule ポインタとして親 repo にコミットされるため、**評価の再現性**が保証される
- 一次配布元 (`marijaselakovic/JavaScriptIssuesStudy`) はライセンス未明記のまま消滅するリスクがあるため、自家 fork (`tomoya0318/selakovic-2016-issues`) を pin 先とすることでアクセス安定性を確保する
- worktree 間で git objects (履歴・圧縮データ) は `main/.git/modules/selakovic-2016-issues/` に一元化される (実ファイルのみ worktree ごとに展開)

### 新規 clone 時

```bash
git clone --recurse-submodules <this-repo-url>
```

### 既存 clone / 新 worktree で実ファイルを展開

```bash
git submodule update --init --recursive
```

`start-worktree` skill の `SETUP_COMMANDS` ([`open-in-cmux.sh`](../../.agents/skills/start-worktree/open-in-cmux.sh)) に組み込み済みのため、新 worktree では自動展開される。

## ディレクトリ構造

```
selakovic-2016-issues/
├── README.md              実行プロトコル (jsexecutor <before> <after> Nvm Nwarmup Nmeasure 0.9)
├── Description.md         98 件の PR 番号・ライブラリ・変換説明・root cause 一覧
├── Confirmed.md           上流に accept された最適化の報告
├── jsexecutor*.js         Node 側ベンチマーク実行器 (warmup 付き版あり)
├── browserJsExecutor.js   ブラウザを spawn して v_*.html を実行
│
├── clientIssues/          ブラウザ専用 (DOM/jQuery 依存) — 32 件
│   └── {Angular,Ember,JQuery,React}Issues/issues/issue_NNNN/
│       ├── v_before.html, v_after.html            ← 等価性検証対象 (<script> 内 f1)
│       └── <lib>_before.js, <lib>_after.js, <lib>.js~
│
├── serverIssues/          Node 専用 (fs/chalk など) — 17 件
│   └── {Chalk,Cheerio,Mocha,Request,Socket.io}Issues/issues/issue_NN/
│       ├── test_case_before.js, test_case_after.js   ← ハーネス (init/setupTest/test)
│       └── <lib>_before.js, <lib>_after.js           ← 等価性検証対象
│
└── clientServerIssues/    両方で走る中立ライブラリ — 28 件
    └── {Backbone,Ejs,Moment,NodeLruCache,Q,Underscore,Underscore.string}Issues/issues/issue_NN/
        ├── test_case_before.js, test_case_after.js   ← Node ハーネス
        ├── v_before.html, v_after.html               ← ブラウザハーネス (冗長系)
        └── <lib>_before.js, <lib>_after.js           ← 等価性検証対象
```

## 等価性検証器の `{setup, slow, fast}` への対応

| カテゴリ               | slow / fast の抽出単位                                    | setup の抽出                            | 手段                                                                    |
| :--------------------- | :-------------------------------------------------------- | :-------------------------------------- | :---------------------------------------------------------------------- |
| **clientIssues**       | `v_*.html` の `<script>` 内 **`f1` 関数本体**             | `f1` 定義より前の `var` 宣言部          | HTML parser で `<script>` 抽出 → `@babel/parser` で `f1` body を切り出し |
| **serverIssues**       | `test_case_*.js` が呼ぶ API の、`<lib>_*.js` 側関数 body  | `test_case_*.js` の `init`/`setupTest`  | `diff <lib>_before.js <lib>_after.js` で変更関数を特定                  |
| **clientServerIssues** | 同上 (`test_case_*.js` を優先。`v_*.html` は**不使用**)   | 同上                                    | 同上                                                                    |

### 境界設定の注意

- **clientIssues の `f1`**: `execute(f1, 10)` に渡されるクロージャで、jsperf ベンチマーク関数に相当。DOM 操作 (`$.ajax`, `$('#message').html(...)` 等) は **外側のレポーティング用**なので等価性検証では除外する。
- **server / clientServer**: ライブラリ全体を diff するとリファクタ/整形による無関係変更まで拾ってしまう。必ず `test_case_*.js` の call site から逆引きし、**影響関数のみに narrowing** すること。
- **`clientServerIssues/*/v_*.html`**: performance 測定用の browser 再現であり、等価性検証では冗長。Node ハーネス (`test_case_*.js`) を正とする。

### 前処理パイプライン (擬似コード)

```
for issue_dir in data/selakovic-2016-issues/**/issues/*/:
  if v_before.html exists and test_case_before.js not exists:   # clientIssues
    slow  = extract_f1_from_html(v_before.html)
    fast  = extract_f1_from_html(v_after.html)
    setup = extract_pre_f1_vars(v_before.html)
  else:                                                           # server / clientServer
    harness = load(issue_dir + '/test_case_before.js')
    slow/fast = 影響範囲を narrowing した <lib>_{before,after}.js 抜粋
    setup    = harness.init + harness.setupTest
  checker.check({setup, slow, fast})
```

## ground truth (Description.md)

`Description.md` の「変換説明」列をパースすれば、Selakovic 論文 Table 4 の **10 パターン**のどれに該当するか事前分類できる。等価性検証器の期待判定 (equal/not_equal) の ground truth としても流用可能。

## 既知の抜け・不確実性

- `clientIssues/*/<lib>.js~` (末尾チルダ): 編集前のバックアップと推測されるが README/wiki に言及なし。**`<lib>_before.js` を正とし `.js~` は無視**するのが安全。
- `<lib>_before.js` / `<lib>_after.js` はライブラリ全体 diff のため、整形やコメントだけの無関係な変更も含む。narrowing 前処理が前提。
- 論文で言及される「新規発見 139 件」は repo に**含まれていない**。
