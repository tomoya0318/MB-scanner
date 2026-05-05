# テスト・品質チェックガイド

## 基本方針

- **必須事項**: 新機能の実装には必ずテストを追加すること（Python 側は `pytest`、TypeScript 側は `vitest`）。
- **網羅性重視**: プロダクトコードではなくテストが仕様書・レビュー対象となるため、正常系・異常系・境界系を網羅する。
- **カバレッジで盲点を可視化**: 「到達していない分岐」を検出するため、カバレッジを計測して基準値を満たすこと。
- **モックは外部境界のみ**: 内部ロジックのモックは避け、Protocol（Python）/ 型境界（TS）単位で差し替える。

## 構成

本プロジェクトは Python 側と TypeScript 側で使用するフレームワーク・モック指針・カバレッジ基準が異なるため、以下の 2 文書で個別に詳細を扱います。

- [`mb-scanner.md`](mb-scanner.md) — Python 側 (`mb_scanner/`) の `pytest` ベースガイドライン
- [`mb-analyzer.md`](mb-analyzer.md) — TypeScript 側 (`mb-analyzer/`) の `vitest` ベースガイドライン

本 index.md では両コードベースにまたがる **共通原則** のみを扱います。

---

## 共通のテスト原則

### ケース網羅

各 public な関数・メソッドに対し、少なくとも以下の 3 パターンを確認すること。

- **正常系**: 期待通りに動作するか
- **異常系**: 不正入力・外部エラー・タイムアウト等で期待通り失敗するか
- **境界系**: 空入力、最小/最大値、重複、存在しない ID、配列の要素数 0/1/N などのエッジ

### モック化の原則

| モックすべき対象 | モックしてはいけない対象 |
|---|---|
| 外部 API 通信（GitHub、HTTP 全般） | DB（Python: インメモリ SQLite、TS: 該当なし） |
| 外部コマンド実行（`subprocess`、`node dist/cli.js`） | ドメインモデル（Pydantic / shared/{equivalence,pruning}-contracts.ts） |
| ファイルシステムへの実 I/O（Gateway 層で抽象化済みのもの） | 純粋ロジック関数 |

内部ロジックをモックするとテストが実装の写像になり仕様検証として機能しなくなる。必ず**ポート（Python Protocol / TS 型境界）単位**でモックすること。

### カバレッジ基準

- カバレッジ**数値そのものを目標にしない**。分岐の質（異常・境界系の網羅）を確認する補助指標として使う。
- 言語別の具体的基準は各ドキュメントを参照。

---

## 実行フロー

### 作業完了時のチェック

変更範囲が Python 側・TypeScript 側どちらでも、最終的に以下 1 コマンドで全体を検証する:

```bash
mise run check
```

これで Lint / 型チェック / アーキ検証 / pytest / vitest がまとめて走ります。個別コマンドは言語別ドキュメントを参照。

### カバレッジ計測

- Python 側: `mise run test-cov`
- TypeScript 側: `mise run test-analyzer-cov`

CI には組み込まず、開発者がローカルで盲点を洗い出す用途に使う想定。

---

## Python ↔ TypeScript をまたぐ契約のテスト

`mb_scanner/domain/entities/{equivalence,pruning,preprocessing}.py` と `mb-analyzer/src/contracts/{equivalence,pruning,preprocessing}-contracts.ts` の型定義は JSON 契約で一致している必要がある（詳細は [`../architecture/index.md`](../architecture/index.md)）。これを壊さないため:

- Python 側: `tests/adapters/gateways/equivalence/` に subprocess を介した integration test を配置し、`dist/cli.js` を実機呼び出しで検証する
- TypeScript 側: `tests/contracts/{equivalence,pruning}-contracts.test.ts` で Python 側 Pydantic 互換の型ガードを確認、`tests/cli/` で stdin/stdout 経由の E2E を確認する

片側の変更でも両側のテストを走らせること (`mise run check` を使えば自動)。
