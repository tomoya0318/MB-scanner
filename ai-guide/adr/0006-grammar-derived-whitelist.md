# ADR-0006: pruning 候補 whitelist を `@babel/types` の文法 alias から自動導出する

- **Status**: accepted
- **Date**: 2026-04-27
- **Related**: ADR-0005 (blacklist 側の同方針), `mb-analyzer/src/pruning/rules/whitelist.ts`, `mb-analyzer/src/pruning/rules/replacement.ts`, `ai-guide/code-map.md` §Pruning エンジン, `ai-guide/current-research.md` §第 1 段階

## コンテキスト

ADR-0005 で pruning の候補位置 blacklist (L1) は `@babel/types` の文法メタデータから自動導出される構造になり、Selakovic 2016 dataset への依存が解消された。一方 **whitelist (`pruning/rules/whitelist.ts:WHITELIST_CATEGORIES`) は依然として手選別** で、初期 plan (`tmp/0002_hydra-pruning-engine/plan.md` L30-31) で「JS によく出る型」として 16 型程度を挙げ、実装中に 24 型まで膨らんだ状態のまま運用されている。

実測した結果:

| | Babel alias 全体 | 現状 WHITELIST_CATEGORIES | カバー率 |
|---|---|---|---|
| Statement | 47 型 | 6 型 | 12.8% |
| Identifier | 1 型 | 1 型 | 100% |
| Expression | 52 型 (Identifier 含む) | 17 型 | 32.7% |
| 合計 | 99 型 | 24 型 | **約 24%** |

抜けている 75 型を性質別に分けると:

- **(a) 言語拡張・experimental** ~35 型: Flow / TS / JSX / stage-1 以下 (BindExpression / DoExpression / Pipeline 系等)
- **(b) ECMAScript core** ~40 型: ループ系 (`While/Do/For/ForIn/ForOf`)、関数式 (`Function/Arrow/ClassExpression`)、フロー制御 (`Break/Continue/Labeled`)、async 系 (`Await/Yield`)、optional chaining (`Optional(Member|Call)Expression`)、`Try/Switch`、`Tagged/TemplateLiteral`、`This/Super/MetaProperty` 等

(a) は ECMAScript core 外なので原則ベースで除外を defensive 抜きに説明できるが、(b) は **JS の現役構文で除外理由が「実装者の見えていた範囲」以外に存在しない**。これが論文上 3 つの問題を生む:

1. **第 1 段階の "最小構造パターンの導出" claim が部分的にしか成立しない** — 「24 型の範囲内での最小」と但し書きが必要
2. **OSS 適用フェーズの recall 低下** — ループや関数式を含むパターンが具体形のまま残り、変種にマッチしない
3. **第 3 段階 ablation の解釈が空転** — 「whitelist 不在で取り損なった分」と「過剰 wildcard 化を補正した分」が区別できない

ADR-0005 の論理 (「L1 = 文法レベル / L4 = 意味論レベル」の clean な層分離) は **whitelist が grammar-derived であってはじめて L1 全体として成立する**。本 ADR は ADR-0005 の延長として whitelist 側の defensive 化を扱う。

## 選択肢

- **A. 現状維持 (手選別 24 型)**: plan.md の列挙をそのまま使う
- **B. alias-driven 全展開 + 機械的除外**: `t.FLIPPED_ALIAS_KEYS.Statement` / `t.FLIPPED_ALIAS_KEYS.Expression` を全展開し、prefix / experimental タグで mechanical に除外
- **C. whitelist 廃止 (型レベル除外を持たない)**: WHITELIST_CATEGORIES を 1 段廃止し、L1 blacklist + L3 round-trip + L4 等価性のみで候補管理

### 評価

| 軸 | A (手選別) | B (alias-driven) | C (whitelist 廃止) |
|---|---|---|---|
| Dataset leak (論文 validity) | ❌ あり | ✅ 解消 | ✅ なし |
| 第 1 段階の "最小パターン" claim | ❌ 部分的 | ✅ 完全 | ✅ 完全 |
| OSS recall (核心 b 型のカバー) | ❌ 不可 | ✅ 可 | ✅ 可 |
| 第 3 段階 ablation 解釈 | ❌ 空転 | ✅ clean | △ 過剰 wildcard 化が他層で混入する可能性 |
| 試行コスト | ✅ 最小 | △ 増 (L1/L3 が大半吸収) | ❌ 大幅増 (cheap fail も dispatch される) |
| カテゴリ分類 (statement/expression/identifier) の存在 | ✅ ある | ✅ ある | ❌ 失われ、置換モード選択が困難 |
| 実装コスト | ✅ 0 | △ 中 (除外リスト整備) | △ 大 (`replacement.ts` と `REPLACEMENTS` の構造変更) |
| Babel 追随保守 | 手動 | 自動 (除外集合のみ手動) | 自動 |

C 案は **置換モード選択の根拠を失う**ため採用困難: 候補ノードに対して `deleteStatement` / `wildcardIdentifier` / `wildcardExpression` のどれを呼ぶかを決めるには「statement か / expression か / identifier か」のカテゴリ判定が必要で、これを廃すると alias 名から都度判定するか別の構造を作る必要がある。alias 由来 WHITELIST_CATEGORIES は B 案でも維持されるので、C のメリット (廃止) は得られない。

A 案は dataset leak を残すうえ、第 1 段階 claim が「核心 (b) 40 型を取りこぼした最小化」に縮退するので採用しない。

## 決定

**B (alias-driven 全展開 + 機械的除外) を採用**。

主要な根拠:

1. **ADR-0005 と同じ論理を whitelist に適用するだけ**で、L1 全体 (whitelist + blacklist) が文法由来になる。論文中で「L1 は `@babel/types` から mechanically 導出」と 1 文で説明できる
2. **(b) 40 型がカバーされる**ことで第 1 段階の recall 上限が真に文法上限に到達。第 3 段階 ablation は純粋な precision 補正として解釈可能
3. **試行コスト増は L1 grammar-blacklist が大半吸収**する。ADR-0005 の grammar-blacklist は alias-derived なので、新型を whitelist に追加しても**自動で適切な親子位置除外が効く** (再実装不要)
4. **コード変更は `whitelist.ts` 1 ファイルに局所化**。`replacement.ts:REPLACEMENTS` / `engine.ts` は無改修で動く

### 実装方針

#### カテゴリ振り分け規則

```
Babel alias                  → NodeCategory
─────────────────────────────────────────
"Identifier" 単独            → identifier
FLIPPED_ALIAS_KEYS.Statement → statement
FLIPPED_ALIAS_KEYS.Expression
  ∖ {"Identifier"}           → expression
```

`Identifier` は Expression alias にも属するが、binding 位置除外を grammar-blacklist 側で扱うため (ADR-0005:71-77 参照) `identifier` カテゴリとして分離する。

#### 機械的除外集合

以下 3 群を whitelist から除外する。各群の論理は性質が異なる:

| 除外群 | 判定 | 除外論理 | Defensive? |
|---|---|---|---|
| **構造的 no-op (parser plugin OFF 由来)** | 型名 prefix / 既知リストで `typescript`, `flow`, `jsx` plugin 専用と判定される全型 | parser config (`pruning/ast/parser.ts:plugins`) で当該 plugin が無効化されている → 当該型は parse 結果の AST に**生成不能** → whitelist 含有は vacuous | ❌ **不要** (parser 設定の従属) |
| **アルゴリズム不変条件 (常に除外)** | `EmptyStatement` | これ自体が `deleteStatement` の置換ターゲット。whitelist 入りすると自己置換ループ | ❌ 不要 |
| **時点規範的除外** | 本 ADR の `Date` 時点で TC39 stage < 4 (= "Finished" 未到達) と分類された experimental 構文の明示リスト: `BindExpression` (stage 0), `DoExpression` (stage 1), `RecordExpression` (stage 2 → withdrawn 2023), `TupleExpression` (stage 2 → withdrawn 2023), `ModuleExpression` (stage 1), `PipelineBareFunction` (stage 2), `PipelinePrimaryTopicReference` (stage 2), `PipelineTopicExpression` (stage 2), `TopicReference` (stage 2), `DecimalLiteral` (stage 1) | TC39 自身が stage 4 を **"Finished (仕様確定)"** と定義。それ未満は AST 構造が変動するリスクがある (例: Records & Tuples は stage 2 で withdrawn、Pipeline は F# / smart / Hack で AST が複数回変更されてきた)。**実験時点の Babel version で AST 型集合は完全 pin され (`pnpm-lock.yaml`)、stage 分類は本 ADR の Date と TC39 提案リポジトリ で検証可能** ⇒ 再現性が担保される | ❌ **不要** (TC39 公式定義 + Babel version pin) |

第 1 群の論理:

```
T が plugin X (X ∉ enabled) によってのみ生成される構文型
  ⇒ どんな input でも T ∉ AST(parse(input))
  ⇒ T を whitelist に含めても観測可能な効果はない (no-op)
  ⇒ T の除外は表現の整理であって方法論的決定ではない
```

これにより論文中で reviewer に「Flow 構文を除外したのは Selakovic dataset を見たからか?」と問われても、「Flow plugin を有効化していない以上 AST に Flow 型が現れることは parser 挙動として不可能。dataset を見るまでもなく除外は no-op として決まる」と返せる。**whitelist は parser config の従属変数**。

#### Invariant: parser config と whitelist の paired-change 原則

parser plugin と whitelist 除外群は対象言語の**同期した表現**として扱う:

```
parser.ts:plugins         whitelist.ts (除外群)
─────────────────────────────────────────────────────
[]                         TS/JSX/Flow を全除外 (← 現状)
["typescript"]             TS 群を除外から外す
["jsx"]                    JSX 群を除外から外す
["flow"]                   Flow 群を除外から外す
["typescript", "jsx"]      TS + JSX 群を除外から外す
```

両者を別々に変更することは**禁止**する:

- parser が生成しない型を whitelist に含める → vacuous (実害はないが意図不明)
- parser が生成する型を whitelist から落とす → recall 低下 (本来縮められる構造が縮まらない)

実装側は `pruning/rules/whitelist.ts` で「parser config から導出した whitelist を返す」関数として表現し、parser 設定変更が直接 whitelist に伝播するようにする (詳細は実装ステップ参照)。

### 対象言語拡張で扱える dataset 例

各 parser plugin を有効化することで対象に追加できる dataset を整理する。実装変更は `parser.ts:plugins` への追加と `whitelist.ts` の除外群解除を **paired** で行う。

#### `typescript` plugin

**有効化で含まれる主な AST 型**: `TSAsExpression` (`x as T`), `TSNonNullExpression` (`x!`), `TSTypeAssertion` (`<T>x`), `TSSatisfiesExpression` (`x satisfies T`), `TSInstantiationExpression`, `TSInterfaceDeclaration`, `TSEnumDeclaration`, `TSModuleDeclaration`, `TSTypeAliasDeclaration`, `TSDeclareFunction`, `TSImportEqualsDeclaration`, `TSExportAssignment`, `TSNamespaceExportDeclaration`

**追加可能な dataset 例**:
- **DefinitelyTyped (`@types/*`)** の型定義修正履歴 — TS 型システム関連の bug fix dataset
- **大規模 TS プロダクト**: VS Code, Slack desktop, Discord client, Figma plugin runtime, Notion frontend
- **TS-first フレームワーク**: NestJS, Angular, Vue 3 (Composition API), tRPC
- **TypeBugs / TypeFix 系の研究 dataset** (TS の bug fix patterns)
- **`as const` / `satisfies` の pattern 研究** (TS 4.9+ 構文の活用パターン)

#### `jsx` plugin

**有効化で含まれる主な AST 型**: `JSXElement`, `JSXFragment`, `JSXOpeningElement`, `JSXClosingElement`, `JSXAttribute`, `JSXSpreadAttribute`, `JSXExpressionContainer`, `JSXNamespacedName`, `JSXMemberExpression`

**追加可能な dataset 例**:
- **React コンポーネントライブラリ**: Material UI (MUI), Chakra UI, Ant Design, Radix UI
- **React アプリケーション OSS**: Excalidraw, tldraw, Reddit, Bluesky web
- **Storybook stories** (component variant の網羅的記述パターン)
- **Next.js / Remix アプリケーションコード**
- **React Native アプリケーション**
- **JSX ベース DSL**: HTM, Vhtml, mdx-js
- **React-specific anti-pattern dataset** (e.g., `useEffect` 誤用、prop drilling)

#### `flow` plugin

**有効化で含まれる主な 型**: `TypeAlias`, `OpaqueType`, `InterfaceDeclaration` (Flow 版), `EnumDeclaration` (Flow 版), `TypeCastExpression` (`(x: T)`), `Declare*` 系 (`DeclareClass`, `DeclareFunction`, `DeclareModule`, ...)

**追加可能な dataset 例**:
- **Meta レガシー OSS**: Yarn classic, Jest 古いバージョン, React Native の Flow 時代コード, Flow itself のテストケース
- **2015〜2018 年頃の OSS**: Flow が一部採用されていた時代のプロジェクト
- **Flow → TypeScript migration history dataset** (型システム移行に関する比較研究)
- **注意**: 新規 Flow 採用プロジェクトはほぼ皆無。historical comparative study には有用だが、modern JS dataset を増やす目的では推奨しない

#### 同時有効化

複数 plugin が必要な場合 (`.tsx` 等) は同時に有効化:

| 組み合わせ | 対象 dataset |
|---|---|
| `typescript` + `jsx` | `.tsx` ファイル — modern React + TS プロジェクト全般 |
| `flow` + `jsx` | 古い React + Flow プロジェクト (Yarn classic 等) |

**制約**: `typescript` と `flow` は **同時有効化不可** (Babel が型システム両立を許さない)。両方を扱いたい場合は input ごとに parse instance を分ける必要があり、それを行うのは `PruningInput.language` 等の per-input 言語パラメータ導入時 (本 ADR の将来拡張節 + 別 ADR を新規起票)。

#### 想定カバレッジ

| | 現状 | Case B 後 (推定) | Babel 全体 |
|---|---|---|---|
| statement | 6 | ~24 | 47 |
| identifier | 1 | 1 | 1 |
| expression | 17 | ~33 | 52 |
| 合計 | 24 (24%) | **~58 (59%)** | 99 |

残り 41 型はすべて (a) (言語拡張 + experimental + 既に最小) で principle 化可能なので、論文中で defensive な議論は不要。

#### unsoundness 観点

新規追加される (b) 40 型はいずれも「**置換しても文法的には valid だが意味論的に等価でないことが多い型**」を含む (例: `BreakStatement` を EmptyStatement で消すと制御フローが壊れる)。これらは **L4 等価性検証で必ず弾かれる** ため、追加によって unsound な縮小は発生しない (ADR-0005:97 と同じ層分離の論理)。

新型追加によるリスクは **試行コスト増** のみで、その吸収機構は既存:

- L1 (文法 blacklist): alias-derived なので新型を自動で `Statement` / `Expression` 受理位置に振り分け、不正位置を事前除外
- L3 (round-trip): 文法的不正な置換を低コストで弾く (parse のみ)
- L4 (Hydra 実行): 意味論的不正を最終的に弾く (高コストだがここまで来る候補は L1/L3 で大幅減)

### 実装ステップ

1. `pruning/ast/parser.ts:plugins` を **`[]` (素 JS 限定)** に変更 (TS / JSX plugin を OFF)。本 ADR 採択時点で同梱の paired-change
2. `pruning/rules/whitelist.ts` を `t.FLIPPED_ALIAS_KEYS` ベースの動的構築に書き換え。除外集合は本 ADR §機械的除外集合の 3 群を別定数で表現:
   - `isPluginExcluded(type)` — `PARSER_PLUGINS` から有効化されていない plugin 由来の型を判定 (構造的 no-op)
   - `ALREADY_MINIMAL_TYPES` — `EmptyStatement` (アルゴリズム不変条件)
   - `EXPERIMENTAL_TYPES` — TC39 stage < 4 の明示リスト (時点規範的除外)
3. parser config から有効 plugin 集合を読み、`PARSER_PLUGIN_DEPENDENT_TYPES` のうち**有効化されていない plugin の型のみ**を最終除外集合に組み入れる (paired-change 原則の実装表現)
4. snapshot test で「現状 24 型 → 新 ~58 型」の差分を可視化 (現状エントリが全て新リストに含まれていることを assertion で固定)
5. `tests/pruning/engine.test.ts` と integration test (`tests/integration/selakovic-2016.test.ts`) で recall 改善 / iterations 増加を観測
6. Babel メジャーバージョン更新時の追従ヘルパとして、CI で「3 群の除外集合に該当しない新型が現れたら通知」する snapshot test を追加

## 結果 / 影響

**得るもの:**

- 論文中で "whitelist は `@babel/types` の Statement / Expression alias から導出され、Selakovic dataset には依存しない" と defensive 抜きに主張できる
- 第 1 段階の recall 上限が文法上限に到達。第 3 段階 ablation が純粋な precision 効果として解釈可能
- OSS 適用フェーズで modern JS (ループ・関数式・async・optional chaining) を含むパターンが正しく抽象化される
- Babel バージョン更新で新型 (新 stage-4 構文等) が入れば**自動で whitelist が拡張**される (除外集合に該当しなければ含まれる)
- ADR-0005 とペアで「L1 (whitelist + blacklist) は完全に grammar-derived」と主張できる

**諦めるもの・将来のコスト:**

- 試行回数増 (`PruningResult.iterations`) — `max_iterations` の default 値見直しが必要になる可能性。実測してから判断する
- experimental 除外リストの保守 — TC39 stage 4 進行で stage-1 構文が core になった場合、明示リストから外す手作業が発生する。CI snapshot test で検出
- `t.FLIPPED_ALIAS_KEYS` の semi-public API 依存 — ADR-0005 と同じ Babel 内部 API リスク。Babel メジャーバージョン更新時の検出は ADR-0005 の枠組み (`src/pruning/rules/{whitelist,blacklist}.ts` 末尾 in-source の主要位置 pin) を再利用

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- **対象言語が拡張される** — TS / Flow / JSX を含む dataset を扱う必要が生じた場合、`parser.ts:plugins` への有効化と `whitelist.ts` の除外群解除を **paired** で行う。本 ADR 本体を改訂し、§対象言語拡張で扱える dataset 例 に該当エントリを追記する (新規 ADR は不要)
- **単一プロセスで複数言語を扱う必要が生じる** (例: TS と素 JS が混在する dataset) — `PruningInput.language` 等の per-input 言語パラメータを導入する別 ADR を新規起票
- alias-driven whitelist 採用後、**`PruningResult.iterations` の中央値が現状の 5 倍以上**に増えるなど試行コストが想定外に大きい
- TC39 stage 4 へ昇格した構文 (例: `Pipeline` が Hack 案で stage 4 到達) が出現した場合、`EXPERIMENTAL_TYPES` リストから除外し本 ADR の Date を更新
- Babel メジャーバージョン更新で `FLIPPED_ALIAS_KEYS` 構造または alias 名が変わる
- OSS 適用フェーズで「ループや関数式の wildcard 化が本来不要だった」ケースが多発し、第 3 段階の precision 補正コストが過大になる

対象言語拡張・per-input 化以外のトリガーで判断方針が覆る場合は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- production と test の責務分離は ADR-0005 と同じ: production は alias 引きの最小実装、差分監視は test 側 (in-source の主要位置 pin。cross-check は ADR-0005 採択後に削除済み — ADR-0005 「補足: 2026-04-30 cross-check (B-B) 削除」)
- 「core JS 構文の包含」原則は研究コミュニティで広く共有される基準なので、reviewer に説明する際の defensive コストは ADR-0005 と同程度かそれ以下
- 本 ADR と ADR-0005 のペアにより、`pruning/rules/whitelist.ts` と `pruning/rules/blacklist.ts` の両方が `@babel/types` の introspection から導出される構造になる。論文中の第 1 段階説明で「文法由来 (grammar-derived)」と一言でカバーできるようになるのが本 ADR の最大の効用
