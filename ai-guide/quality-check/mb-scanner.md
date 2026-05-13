# mb-scanner (Python 側) テストガイド

Python 側コードベース `mb_scanner/` のテスト詳細。共通原則は [`index.md`](index.md) を参照。

---

## フレームワーク

- **テストランナー**: `pytest`
- **DB テスト**: インメモリ SQLite (`sqlite:///:memory:`) を使用し、テストの独立性と速度を確保する
- **フィクスチャスコープ**: 原則として `function` スコープで隔離し、テスト間の依存を排除する

---

## ディレクトリ構成と命名

`tests/` 以下に Clean Architecture の 4 層構造をミラーした形で配置する。

```
tests/
├── domain/entities/          # ドメインモデルのテスト
├── use_cases/                # Use Case のテスト
├── adapters/
│   ├── cli/                  # CLI コマンドのテスト
│   ├── repositories/         # Repository 実装のテスト
│   └── gateways/             # Gateway 実装のテスト
│       ├── github/
│       ├── codeql/
│       ├── equivalence/      # TS 側との subprocess integration test
│       ├── visualization/
│       └── code_counter/
└── infrastructure/           # DB接続・設定のテスト
```

- **関数名**: `test_` プレフィックス + 条件 + 期待結果（例: `test_save_project_new`、`test_execute_raises_on_duplicate`）

> Python 側では in-source testing (実装ファイル内にテストを同居させる方式) は採用しない。テストは常に `tests/` ツリーに配置する。TypeScript 側 (`mb-analyzer/`) のみ ADR-0007 で内部ヘルパ専用の in-source 規約を持つが、Python 側に持ち込むかは別 ADR で判断する。

---

## フィクスチャ (conftest.py)

共通のセットアップ処理は `tests/conftest.py` に集約されています。

- `test_db`: エンジン作成・テーブル作成・セッション生成・クリーンアップを一括管理する
- **原則**: Arrange フェーズを簡潔に保つため、共通化できるものはフィクスチャ化すること

---

## カバレッジ基準

- **Use Cases 層**: `mb_scanner/use_cases/` 配下の public メソッドは **100% テスト**
- **Repository 層**: `mb_scanner/adapters/repositories/` の CRUD 操作は **100% テスト**
- **Gateway 層**: `mb_scanner/adapters/gateways/` は外部 API 呼び出し部をモックした上で、エラーハンドリング分岐も含めてテスト
- **ケース網羅**: 各メソッドに対し、正常系・異常系・境界系を確認（詳細は [`index.md`](index.md) 共通原則）
- **エッジケース**: 文字列処理や配列操作ではパターンの違いを網羅
  - 例: JSON フォーマット処理 → プリミティブ配列、オブジェクト配列、ネスト配列の各ケース
  - 例: 正規表現マッチ → マッチする/しない境界条件を複数テスト

### 計測コマンド

```bash
mise run test-cov
# 内部で uv run pytest tests/ --cov=mb_scanner --cov-report=term-missing を実行
```

`term-missing` で未到達行が表示されるため、数値ではなく **どの分岐が落ちているか** を見て埋めること。

---

## モック化の指針

### モックすべき対象

- **Gateway 層**: `mb_scanner/adapters/gateways/` 配下のクラス（GitHub、CodeQL、visualization 等）
- **外部 API 通信**: 実際に HTTP リクエストを送信してはならない
- **外部コマンド実行**: `subprocess` による CodeQL / git / `node dist/cli.js` の実行

### モックしてはいけない対象

- **Database**: `sqlite:///:memory:` を使用し、SQLAlchemy のセッション自体はモックしない（クエリの整合性を確認するため）
- **Pydantic Models**: ドメインエンティティは実体を使用する
- **Protocol / ポート**: 抽象境界なのでモックで差し替える（**これは対象に含まれる**）

### 実装方法

- **ツール**: `unittest.mock` または `pytest-mock`（`mocker` フィクスチャ）を使用
- **DI**: Use Case のテストでは、コンストラクタで受け取る Protocol をモックに置き換える

```python
def test_search_and_store(mocker):
    mock_gateway = mocker.Mock(spec=GitHubGateway)
    mock_gateway.search_repositories.return_value = [...]
    mock_repo = mocker.Mock(spec=ProjectRepository)
    use_case = SearchAndStoreUseCase(gateway=mock_gateway, repository=mock_repo)
    use_case.execute(...)
    mock_gateway.search_repositories.assert_called_once()
```

---

## 品質チェックコマンド (Python 単体)

```bash
uv run pytest                                     # 全テスト
uv run pytest tests/path/to/test.py              # 特定ファイル
uv run pytest tests/path/to/test.py::func_name   # 特定関数
uv run pytest -k "keyword"                       # キーワード一致テスト
mise run test-cov                                # カバレッジ計測
mise run lint                                    # ruff check
mise run fix                                     # ruff format + ruff check --fix
mise run typecheck                               # pyright
```

作業完了時は `mise run check` で両言語まとめて検証する（[`index.md`](index.md) 参照）。

---

## デバッグのヒント

- 一時的なデバッグには `print()` と `pytest -s` を併用しても良いが、**コミット前に必ず削除**すること
- 複雑なロジックの確認には `pdb.set_trace()` の使用を許可するが、これもコミット前に除去すること
- 失敗時の詳細ログは `pytest -vv --tb=long` で確認
