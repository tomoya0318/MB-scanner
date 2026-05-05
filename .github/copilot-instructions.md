# GitHub Copilot Review Instructions

本リポジトリは 1 人運用のため、Copilot レビューは **self-review の代替** として機能させる。観点の本体は `ai-guide/` に集約しているので、本ファイルは橋渡し + 重点項目の提示のみを行う (内容を重複させない)。

## 必読: 観点本体

- **アーキ契約**: `ai-guide/architecture/index.md` (言語別 `mb-scanner.md` / `mb-analyzer.md`)
- **品質・テスト基準**: `ai-guide/quality-check/index.md` (同上 2 ファイル)
- **設計経緯**: `ai-guide/adr/` 配下の ADR (PR で言及がある番号を参照)

## 重点チェック (self-review 代替の最低ライン)

1. **依存方向**: Python `domain → use_cases → adapters → infrastructure`、TS `shared → equivalence-checker → pruning → ... → cli` のゾーン違反。Protocol 抜け道や型 only import で `mise run check-arch` / `mise run lint-analyzer` を擦り抜けていないか目視で確認。
2. **型の厳密性**: `Any` / `any` 禁止。外部境界は Pydantic、内部は TypedDict / TS 型。Pydantic の `extra="ignore"` / `extra="forbid"` の使い分けが PR 内容と整合しているか。`cast` / `as` で narrowing を誤魔化していないか。
3. **JSON 契約 (Python ↔ TS)**: snake_case 統一、列挙値文字列の完全一致。バッチ API の `id` エコーバックや `effective_timeout_ms` 検出機構を破壊していないか。`model_dump_json(exclude_defaults=False, exclude_none=False)` の明示が落ちていないか。
4. **テスト網羅**: 公開関数ごとに正常・異常・境界の 3 系列が揃っているか。内部ロジックのモック禁止 (モックは外部 API・subprocess・Gateway 抽象まで)。新機能でテスト不在は基本 NG。
5. **命名・一貫性**: GitHub リポジトリは `Project` (DB パターンの `Repository` と区別)。ファイル内宣言は **bottom-up** (公開型 → helper → builder → exported const)。同種概念で語彙が割れていないか。
6. **ADR 整合**: 設計に関わる変更で ADR が古くなっていないか。既存 ADR (例: `ADR-0009` の `$Pn;` placeholder) を破壊していないか。
7. **コメント**: 履歴形・「何をしたか」の冗長コメントは削除対象。「なぜ」が非自明な箇所のみ残す。`current-research.md` に実装詳細が混入していないか。
8. **ローカル検証前提**: `mise run check` がローカルで通る前提の PR か (CI 通過だけに頼っていないか)。

## レビュー粒度の指針

- Lint・format で機械的に直る指摘は重複させない。
- **アーキ違反・型抜け・契約破り・テスト欠落** を最優先で挙げる。
- 軽微な改善提案は `nit:` プレフィックスで分離。
