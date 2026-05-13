# ADR-0008: 候補置換を mutate + revert (savepoint パターン) で実装し cloneAst を廃止

- **Status**: accepted
- **Date**: 2026-04-30
- **Related**: [`ADR-0001`](0001-pruning-ast-traversal.md), [`code-map.md` §pruning の正確性](../code-map.md#pruning-の正確性--多層防御)

## コンテキスト

第 1 段階 pruning の `tryPruneCandidates` は、各候補について「もし置換したら等価か」を 1 つずつ試行し、等価だったものを採用するアルゴリズム。失敗候補は次候補のために捨てて元の slowAst から再試行する必要があり、当初は `replaceNode` 内部で **AST を deep clone してから置換** する方式 (非破壊) を採用していた。

実装すると以下のコストと概念的負債が出てきた:

- **clone コストが毎候補にかかる**: 1 候補試行ごとに `cloneAst` (O(N)) が走る。1 pass で M 候補試行するので O(N×M)
- **clone 後の参照対応が必要**: 候補は元 slowAst の `parent` 参照を持つが、clone 上の同じ位置を取り直す `findCorrespondingNode` (O(N×D) 線形走査) が必要に
- **「対応位置探索」が `ast/replace.ts` の責務を不純にしている**: `ast/replace.ts` の半分以上がこの探索処理で、本来 `ast/` (Babel AST 汎用 toolbox) に属するべきでない pruning 固有の `ReplacementMode` 戦略選択も同居していた

設計を見直すなかで「そもそも slowAst の破壊を回避する必要があるのか」が問い直され、pruning が **単スレッド逐次** であるという前提を活かして、別の解を採用できることが分かった。

## 選択肢

- **A. 現状の clone 方式 (`cloneAst` + `findCorrespondingNode`)**
  - 試行ごとに deep clone してから 1 箇所置換、失敗時はそのまま捨てる
- **B. 構造共有 (path-based + persistent)**
  - 候補に「ルートからの path」を持たせ、clone は経路ノードだけコピー (O(D))
  - 参照ベースから値ベースへの脱却で純粋化、ただし `CandidatePath` の改修が広範に及ぶ
- **C. mutate + revert (DB savepoint パターン)**
  - 元 slowAst を直接書き換え、失敗候補は `try/finally` で必ず revert
  - 等価が成立したら mutate 済み slowAst を捨て reparsed AST を採用、revert 不要
  - clone も対応位置探索も不要、AST インスタンスは常に 1 つ

### 評価

| 観点 | A (clone) | B (path-based + structural sharing) | C (mutate + revert) |
|---|---|---|---|
| 候補ごとのコピーコスト | O(N) | O(D) | **0** |
| 対応位置探索 | O(N×D) (`findCorrespondingNode`) | O(D) (path 経路) | **不要** (参照そのまま) |
| `ast/replace.ts` の純粋性 | × pruning 戦略が混入 | ○ Node 直接受け取り | (削除) |
| `cloneAst` の純粋性 | × | ○ | (削除) |
| 並列化への適性 | ○ (clone なので isolation OK) | ○ | × (mutate なので逐次前提) |
| 実装変更範囲 | (現状) | 中 (CandidatePath 改修 + persistent clone) | 小 (engine.ts 内に閉じる) |
| アルゴリズムとコードの一致 | △ (副産物が多い) | ○ | ○ (savepoint として読める) |

## 決定

**C (mutate + revert)** を採用する。

主要な根拠:

1. **pruning は単スレッド逐次**: `engine.ts` の外側ループも内側ループも `await` を含む完全逐次実行。並列化したいユースケースは現時点で存在せず、要件化された時点で B 案に切り替える余地もある (path-based は構造共有でさらに高速化できる発展形)
2. **概念がアルゴリズムと一致する**: 「試す → 等価なら採用、不等価なら戻す」という savepoint パターンが、SQL transaction の `BEGIN` / `COMMIT` / `ROLLBACK` に対応していて読み手の認知コストが低い
3. **付随する責務の整理が同時に進む**: `cloneAst` と `findCorrespondingNode` が消えることで `ast/replace.ts` ごと削除でき、`ast/` 配下を真に汎用な Babel AST toolbox に純化できる (pruning 固有の `ReplacementMode` 戦略は `rules/replacement.ts:REPLACEMENTS.buildNode` に集約)
4. **計算量が改善する**: 毎候補 O(N) clone + O(N×D) 探索 が消え、O(1) の `readAt` / `applyAt` だけになる。実用差はマイクロ秒オーダー (`checkEquivalence` 数百 ms に対して誤差) だが、概念的に「無駄が無い」状態になる

## 結果 / 影響

採用によって得られるもの:

- `engine.ts:tryPruneCandidates` が savepoint パターンで読める形になる (`saved = readAt(...)` → `applyAt(...)` → `try { ... } finally { if (!succeeded) applyAt(..., saved) }`)
- `ast/replace.ts` を完全削除。`ast/` 配下が `parser` / `inspect` / `diff` の 3 ファイルに集約され、すべて pruning 知識ゼロの汎用 utility に
- `ast/replace.ts` に存在した pruning 固有の戦略 (`ReplacementMode` enum と `buildReplacement`) は `rules/replacement.ts` の `CategoryReplacement.buildNode` に統合 (関数値として表現、enum 不要)
- 候補 `parent` 参照の意味が「元 slowAst のオブジェクト」のまま使えるので、`CandidatePath` に位置情報を増やす必要が無い

諦めるもの・将来のコスト:

- **並列試行ができない**: 複数候補を並列で試したくなったら mutate 方式は使えず、clone 方式 (A) または structural sharing (B) に戻す必要がある
- **失敗パスの revert を `try/finally` で確実にする責任**: `succeeded = true` の代入と `return` の間に純粋な値代入のみを置き、副作用の起きる処理を挟まない規律が必要 (現状の実装はこれを満たしている)
- **`await` 中に AST が「試行状態」のまま静止する**: `checkEquivalence` の await 区間で外部から slowAst を観測する処理があると不整合が見える。現状そういう観測者は engine 内に存在せず、将来 observer を足したくなった時にこの ADR に立ち戻る必要がある

## トリガー (再検討の条件)

以下の条件のいずれかが成立したらこの ADR を見直す:

- **複数候補を並列で試したい要件が出てきた** (例: `Promise.all` で複数 `checkEquivalence` を同時実行)。mutate 方式は逐次前提なので、A (clone) または B (path-based + persistent) に切り替える必要がある
- **`engine.ts` の外側で slowAst を観測する処理が増えた** (例: progress リポーター、UI 表示、共有メモリ越しのデバッガ等)。`await` 中の試行状態が外部に漏れて不整合を起こす
- **`tryPruneCandidates` の `try/finally` パターンが守れないコード変更が来た** (例: 早期 return / continue が増え revert 漏れリスクが上がった)。複雑化したら B に切り替えて副作用を消す方が筋が良くなる

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

mutate + revert で書いた `tryPruneCandidates` の構造 (`engine.ts`):

```ts
for (const candidate of candidates) {
  const replacement = replacementFor(candidate.node);
  if (replacement === null) continue;

  const saved = readAt(candidate.parent, candidate.parentKey, candidate.listIndex);
  if (!applyAt(candidate.parent, candidate.parentKey, candidate.listIndex, replacement.buildNode(placeholderId))) {
    continue;
  }

  let succeeded = false;
  try {
    let code: string, reparsed: File;
    try {
      code = generate(slowAst);
      reparsed = parse(code);
    } catch {
      continue; // round-trip 失敗 (finally で revert)
    }

    iterations += 1;
    const result = await checkEquivalence({ setup, slow: code, fast, timeout_ms });
    if (result.verdict !== VERDICT.EQUAL) continue; // 不等価 → 次候補へ

    succeeded = true;
    placeholders.push({ id: placeholderId, kind: replacement.placeholderKind, original_snippet });
    return { pruned: true, nextAst: reparsed, nextCode: code, iterations };
  } finally {
    if (!succeeded) applyAt(candidate.parent, candidate.parentKey, candidate.listIndex, saved);
  }
}
```

`continue` も `return` も `finally` を経由するので、`succeeded` フラグ 1 個で「採用パスは revert しない / それ以外は必ず revert」が表現できる。
