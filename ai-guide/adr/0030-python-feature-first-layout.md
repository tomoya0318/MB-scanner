# ADR-0030: Python 側を layer-first 4 層 CA から feature-first + flat layout + independence contract へ移行する

- **Status**: accepted
- **Date**: 2026-06-13
- **Related**: [`architecture/mb-scanner.md`](../architecture/mb-scanner.md) (改訂対象の依存方向ルール) / ADR-0007 (in-source testing — tests/ ツリーの扱いに影響) / `tmp/plan.md` (Phase 2 リファクタリング計画 PR-7〜PR-12 / 実装は本 ADR を accepted にした後)

## コンテキスト

Python 側 (`mb_scanner/`) は Clean Architecture 4 層 (`domain → use_cases → adapters → infrastructure`) を `import-linter` の `layers` contract で機械強制している。旧 GitHub 検索 / CodeQL バッチプラットフォーム (B群) の切り出し後、本体に残ったのは equivalence / pruning / preprocessing の 3 パイプライン段だけになり、4 層構造が以下の負債を生んでいる:

1. **層を縦に貫く walk が頻発する**: 1 つの機能 (例: equivalence) を読むのに `domain/entities/equivalence.py` → `domain/ports/equivalence_checker.py` → `use_cases/equivalence_verification.py` → `adapters/cli/equivalence.py` → `adapters/gateways/equivalence/node_runner_gateway.py` の 5 ディレクトリを横断する。機能の凝集が層境界で分断されている。
2. **use_cases が素通しに退化**: `use_cases/pruning.py` (38 行) と `use_cases/preprocessing/selakovic.py` (35 行) は gateway をそのまま呼ぶだけで、層を 1 段増やすだけの空き箱になっている (調査 II)。
3. **同層内の直 import スメル**: `adapters/cli/pruning.py:26` / `preprocessing.py:27` が gateway の `INTERNAL_KEY_PREFIX` を、`preprocessing.py:29` が `scan_selakovic_dataset` を gateway から直接 import している (layers contract は同層内 import を縛れない)。
4. **src layout が research/ と非対称**: `mb_scanner/src/mb_scanner/` の src layout に対し、`research/` は flat layout。同一リポジトリで 2 流儀が並走し pyright `executionEnvironments` の設定面積を増やしている。

これらは「層 (technical concern) を第一軸にした」ことに起因する。MB-Scanner は段が直列に流れるパイプラインであり、機能 (パイプライン段) を第一軸にした方が凝集が上がる。本 ADR で構成軸そのものを切り替える。

## 選択肢

- **A. 現状維持 (layers contract のまま rename/整理だけ)**: 4 層を保ち、素通し use_cases と直 import スメルは個別に手当てする。
- **B. feature-first + flat layout + independence contract (= 本 ADR の採用案)**: パイプライン段 (`equivalence` / `pruning` / `preprocessing`) をディレクトリ第一軸にし、`src/` を廃した flat layout に移行、`import-linter` を `layers` → `independence` (段間の相互 import 禁止) に切り替える。Port Protocol は独立 `port.py` を作らず `gateway.py` 先頭に同居させる。
- **C. feature-first だが Port は独立ファイル**: B と同じ構成軸だが、各段に `port.py` を独立ファイルとして残す (型契約と実装をファイル分離する従来の CA スタイル)。

### 評価

| 軸 | A (現状維持) | B (採用) | C (port.py 独立) |
|----|---|---|---|
| 機能の凝集 (1 段 = 1 ディレクトリ) | ✗ 層で分断 | **◎ 段に集約** | ◎ 段に集約 |
| 素通し use_cases の解消 | △ 個別手当て | **◎ 解体して cli→gateway 直結** | ◎ 同左 |
| 直 import スメルの解消 | ✗ layers では縛れない | **◎ gateway.py 同居で自然消滅** | ○ 同居しないので残りうる |
| 依存方向の機械強制 | ◎ layers | **◎ independence (段間遮断)** | ◎ independence |
| ファイル数 | 据え置き | **少 (port を gateway に同居)** | 多 (段 ×port.py 分) |
| research/ とのレイアウト統一 | ✗ src/ 非対称 | **◎ flat に統一** | ◎ flat に統一 |
| 将来段追加 (core/condition/rule 生成) の素直さ | △ 5 ディレクトリに分散追加 | **◎ 段ディレクトリ 1 個追加** | ○ 段 + port.py 追加 |

## 決定

**B (feature-first + flat layout + independence contract + Port は gateway.py 同居)** を採用する。

主要な根拠:
- MB-Scanner は段が直列に流れるパイプラインで、機能 = パイプライン段を第一軸にすると凝集が層構成より高い。将来段 (`core_extraction` / `condition_extraction` / `rule_generation`) も段ディレクトリ 1 個の追加で済む。
- 素通し use_cases (pruning / preprocessing) を解体して cli が Protocol 経由で gateway を直接呼ぶ形にでき、空き層が消える。
- `INTERNAL_KEY_PREFIX` / `scan_selakovic_dataset` の同層直 import スメルは、Protocol と実装を同一 `gateway.py` に同居させることで「同居ファイル内参照」になり自然解消する。`port.py` を独立させる案 (C) はファイル数が段ごとに増えるうえ、型契約と実装が離れて同居メリットを失う。
- `independence` contract は「段は互いに import しない」という MB-Scanner の本質的制約を `layers` より直接に表現する。共通基盤 (`_utils.py` / `_runner.py` / `config.py`) はパッケージルートに置き、各段から共有する (independence は段間のみを縛り、ルート共通基盤への依存は許す)。

### 確定する構成

```
mb_scanner/mb_scanner/          # src/ を廃した flat layout
  equivalence/
    __init__.py
    cli.py        # Typer commands
    gateway.py    # Protocol (先頭) + NodeRunner*Gateway 実装を同居
    models.py     # Pydantic entities
    verdict.py    # derive_overall_verdict / derive_verdict_reason + _finalize
  pruning/
    __init__.py
    cli.py
    gateway.py    # Protocol + 実装
    models.py
  preprocessing/
    __init__.py
    cli.py
    gateway.py    # Protocol + 実装
    models.py
    dataset.py    # scan_selakovic_dataset
  __init__.py
  cli.py          # top-level Typer app (各段の cli を register)
  config.py       # Settings
  _utils.py       # resolve_workers + CLI batch 共通処理
  _runner.py      # Gateway 共通基盤 (PR-11) + BatchItemModel
mb_scanner/tests/ # src layout 廃止に伴い tests/ もパッケージ直下へ
```

**import-linter は `layers` → `independence` に切り替える**:

```toml
[[tool.importlinter.contracts]]
name = "Pipeline components are independent"
type = "independence"
modules = [
    "mb_scanner.equivalence",
    "mb_scanner.pruning",
    "mb_scanner.preprocessing",
]
```

「domain は typer に依存しない」を縛っていた `forbidden` contract は、移行後も維持する (models.py / gateway.py の Protocol が typer を import しないことを保証する)。

### Port Protocol の同居形

```python
# 例: equivalence/gateway.py — Protocol を先頭、実装をその下に同居
class EquivalenceCheckerPort(Protocol):
    def check(self, input_: EquivalenceInput) -> EquivalenceCheckResult: ...
    def check_batch(self, items: Sequence[EquivalenceInput]) -> list[EquivalenceCheckResult]: ...

class NodeRunnerEquivalenceGateway:  # 暗黙的に Protocol を満たす (構造的部分型)
    ...
```

cli は Protocol 型で DI を受け、具象 gateway をルートの composition (`cli.py`) で注入する。DI 方向 (具象を import するのは composition root だけ) は維持する。

## 結果 / 影響

得るもの:
- 1 パイプライン段 = 1 ディレクトリで読め、機能の凝集が層境界で分断されない。
- 素通し use_cases (2 ファイル) が消え、層が 1 段浅くなる。
- 同層直 import スメル 3 箇所が gateway.py 同居で構造的に解消。
- flat layout で research/ とレイアウトが統一され、pyright 設定面積が縮む。

諦めるもの・将来のコスト:
- **layers contract が表現していた「外側→内側の単方向」の保証を失う**: independence は段間の相互 import を禁じるが、段内の層秩序 (cli が models に依存する向き等) は機械強制しない。段内の規律はレビューと慣行に委ねる。
- **型契約 (Protocol) と実装が同一ファイルに同居する**: ファイルが大きくなった段では Protocol の所在が読みにくくなりうる (トリガー参照)。
- **移行コスト**: ファイル移動 + import 書き換え + import-linter / pyright / pyproject の設定追随。本 ADR は機械的移動 (PR-8/PR-9) と共通基盤抽出 (PR-10〜12) に分割して実施する。

### 移行 / 影響範囲

- pyproject: `packages = ["src/mb_scanner"]` → `["mb_scanner"]`、pyright `executionEnvironments` のパス追随、import-linter contract 差し替え (PR-8/PR-9)
- ファイル移動表は `tmp/plan.md` PR-9 の対応表を正とする (cli / gateway+port / entities→models / use_cases 解体 / dataset_scanner→dataset / config / _utils)
- architecture 契約は本 ADR では変更しない。`architecture/mb-scanner.md` の依存方向記述の改訂は実装 PR (PR-9) で paired-change する (ADR は判断、契約は architecture/ が正)
- tests/ の配置は flat layout 移行 (PR-8) と同時に `mb_scanner/tests/` へ移す

## トリガー (再検討の条件)

以下の条件のいずれかが成立したらこの ADR を見直す:

- パイプライン段が互いに import せざるを得ない依存関係が現れたとき → independence contract の前提が崩れる。共通部分をルート共通基盤に括り出せるか、段の切り方が誤っているかを再検討する。
- `gateway.py` 内の Protocol + 実装が読みにくいほど肥大化したとき → その段だけ `port.py` 独立 (案 C) に戻すか検討する (全段一律には戻さない)。
- 段内の層秩序違反 (cli が gateway をバイパスして models を直接組み立てる等) がレビューで頻発するとき → independence に加えて段内 layers を併用する contract を検討する。
- 段でない技術的横断関心 (例: 全段共通の永続化層) が再び必要になったとき → ルート共通基盤で足りるか、層軸の再導入が要るかを判断する。

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- 構成軸・Port 同居・independence contract・flat layout の 4 点は Phase 2 リファクタリングの事前確定方針 (`tmp/plan.md` 冒頭 + Phase 2 節)。本 ADR は実装 PR (PR-8 以降) の前段の合意ゲートで、決定そのものは確定済み。
- ADR の構成軸切り替えに伴い ADR `archived/` ディレクトリは採用しない (Status 行運用に一本化 — adr/README.md 参照)。本 ADR は構成の物理移動であり、過去 ADR (0001〜0028) の判断内容は不変なので supersede しない。
