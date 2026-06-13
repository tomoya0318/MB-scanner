# mb-scanner (Python 側) テストガイド

Python 側コードベース `mb_scanner/` のテスト詳細。共通原則は [`index.md`](index.md) を参照。

---

## フレームワーク

- **テストランナー**: `pytest`
- **フィクスチャスコープ**: 原則として `function` スコープで隔離し、テスト間の依存を排除する

---

## ディレクトリ構成と命名

`mb_scanner/tests/` 以下に feature-first の段構造をミラーした形で配置する (ADR-0030)。各段ディレクトリは `__init__.py` を持つ (テストモジュール名の衝突回避)。

```
mb_scanner/tests/
├── equivalence/              # test_cli / test_gateway(_batch) / test_models / test_verdict / test_selakovic_fixtures
├── pruning/                  # test_cli / test_gateway(_batch) / test_models
├── preprocessing/            # test_gateway(_batch) / test_models
└── fixtures/selakovic/       # 等価性検証の Selakovic 10 パターン fixture
```

- `test_gateway.py` / `test_gateway_batch.py` には TS 側との subprocess integration test (`-m integration`、Selakovic fixture 回帰含む) も同居する。

- **関数名**: `test_` プレフィックス + 条件 + 期待結果（例: `test_parses_stdout_into_domain_model`、`test_subprocess_timeout_becomes_error_verdict`）

> Python 側では in-source testing (実装ファイル内にテストを同居させる方式) は採用しない。テストは常に `tests/` ツリーに配置する。TypeScript 側 (`mb-analyzer/`) のみ ADR-0007 で内部ヘルパ専用の in-source 規約を持つが、Python 側に持ち込むかは別 ADR で判断する。

---

## フィクスチャ

- 現在 `mb_scanner/tests/conftest.py` は無い (旧 DB 用 conftest は legacy へ随伴)
- **原則**: Arrange フェーズを簡潔に保つため、複数ファイルで共通化できるセットアップが生じたら conftest.py に集約すること

---

## カバレッジ基準

- **verdict 導出**: `mb_scanner/equivalence/verdict.py` の public 関数・メソッドは **100% テスト**
- **gateway**: 各段 `mb_scanner/<段>/gateway.py` は subprocess 呼び出し部をモックした上で、エラーハンドリング分岐も含めてテスト
- **ケース網羅**: 各メソッドに対し、正常系・異常系・境界系を確認（詳細は [`index.md`](index.md) 共通原則）
- **エッジケース**: 文字列処理や配列操作ではパターンの違いを網羅
  - 例: JSON フォーマット処理 → プリミティブ配列、オブジェクト配列、ネスト配列の各ケース
  - 例: 正規表現マッチ → マッチする/しない境界条件を複数テスト

### 計測コマンド

```bash
mise run test-cov
# 内部で uv run pytest mb_scanner/tests/ --cov=mb_scanner --cov-report=term-missing を実行
```

`term-missing` で未到達行が表示されるため、数値ではなく **どの分岐が落ちているか** を見て埋めること。

---

## モック化の指針

### モックすべき対象

- **gateway**: 各段 `mb_scanner/<段>/gateway.py` の NodeRunner gateway クラス（equivalence / preprocessing / pruning）
- **外部コマンド実行**: `subprocess` による `node dist/cli.js` の実行（integration マーク付きテストのみ実 Node を起動する）

### モックしてはいけない対象

- **Pydantic Models**: ドメインエンティティは実体を使用する
- **Protocol / ポート**: 抽象境界なのでモックで差し替える（**これは対象に含まれる**）

### 実装方法

- **ツール**: `unittest.mock` または `pytest-mock`（`mocker` フィクスチャ）を使用
- **DI**: Use Case のテストでは、コンストラクタで受け取る Protocol をモックに置き換える

```python
def test_equivalence_verification(mocker):
    mock_checker = mocker.Mock(spec=EquivalenceCheckerPort)
    mock_checker.check.return_value = EquivalenceCheckResult(...)
    use_case = EquivalenceVerificationUseCase(checker=mock_checker)
    use_case.verify(...)
    mock_checker.check.assert_called_once()
```

---

## 品質チェックコマンド (Python 単体)

```bash
uv run pytest                                     # 全テスト
uv run pytest mb_scanner/tests/path/to/test.py              # 特定ファイル
uv run pytest mb_scanner/tests/path/to/test.py::func_name   # 特定関数
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
