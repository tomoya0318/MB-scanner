---
name: check-architecture
description: 実装後にアーキテクチャ・コーディング規約・DB設計の整合性を検証する。Python (mb_scanner/) と TypeScript (mb-analyzer/) で参照ルールが異なるため、変更対象パスから該当ドキュメントを選択して確認する。
allowed-tools: Read, Grep, Glob, Bash, Agent
argument-hint: [path]
---

# check-architecture スキル

実装内容が設計ガイドラインに準拠しているかを検証する。本プロジェクトは Python 側 (`mb_scanner/`) と TypeScript 側 (`mb-analyzer/`) で依存方向ルール・静的解析・コーディング規約が異なるため、変更対象パスに応じて**参照すべきドキュメントを切り替え、その内容に従って**検証する。

**重要**: チェック項目の master は `ai-guide/architecture/` 配下のドキュメント。本 SKILL.md は **手順の定義のみ** を担い、チェック項目そのものは重複定義しない（drift 防止）。

---

## 実行手順

### Step 1: 変更範囲の特定

```bash
git status
git diff --stat
```

### Step 2: 対象言語と参照ドキュメントの決定

| 変更対象パス | 言語 | 参照ドキュメント (必ず Read する) |
|---|---|---|
| `mb_scanner/**`, `tests/**` (ただし `mb-analyzer/tests/` を除く) | Python | `ai-guide/architecture/index.md` + `ai-guide/architecture/mb-scanner.md` |
| `mb-analyzer/**` | TypeScript | `ai-guide/architecture/index.md` + `ai-guide/architecture/mb-analyzer.md` |
| `mb_scanner/mb_scanner/equivalence/models.py` または `mb-analyzer/src/shared/types.ts` | 両方 (横断 JSON 契約) | 上記すべて + `index.md` の JSON 契約節 |
| path 未指定 / 両側に変更あり | 全体 | 上記すべて |

### Step 3: 参照ドキュメントを Read して全項目を確認

該当の `ai-guide/architecture/*.md` を **Read ツールで読み込み**、記載されているチェック項目・依存方向ルール・コーディング規約を **上から順にすべて** 検証する。SKILL.md 側には項目を列挙しないので、必ず ai-guide 側を master として参照すること。

典型的に検証する観点（詳細は ai-guide 側）:
- 依存方向 (Clean Architecture / 依存方向ゾーン) の遵守
- ドメイン層の純粋性 (Python: Pydantic BaseModel / Protocol のみ、TS: shared の末端性)
- コーディング規約 (`Any`/`any` 禁止、命名規則、型 import 使い分け等)
- サブコマンド CLI 契約、並列バッチ処理規約、DB 設計規約
- Python ↔ Node JSON 契約 (snake_case・列挙値・`extra="forbid"`/`"ignore"` 維持)

### Step 4: 機械検証可能な項目を shell で一括チェック

変更対象に応じて以下のスクリプトを実行し、LLM の注意力に依存しない機械検証を走らせる:

```bash
bash .agents/skills/check-architecture/scripts/check-arch-conventions.sh
```

検査内容 (いずれも ai-guide 側ルールを機械化したもの):
- `mb_scanner/mb_scanner/` に `@dataclass` / `dataclasses` import が混入していないか (各段 models 等は Pydantic BaseModel 限定)
- `mb_scanner/` 配下で `rich` / `tqdm` が import されていないか (stderr 進捗表示規約)
- `mb_scanner/mb_scanner/equivalence/models.py` の `EquivalenceInput` が `extra="forbid"` を維持しているか
- `mb_scanner/mb_scanner/equivalence/models.py` の `EquivalenceCheckResult` が `extra="ignore"` を維持しているか

失敗があれば修正してから Step 5 へ進む。

### Step 5: 検証コマンド実行

**Python 単体変更**:
```bash
mise run check-arch    # import-linter でレイヤー契約を検証
mise run typecheck     # pyright
mise run lint          # ruff
mise run test          # pytest
```

**TypeScript 単体変更**:
```bash
mise run lint-analyzer       # ESLint (import/no-restricted-paths 含む)
mise run typecheck-analyzer  # tsc --noEmit
mise run test-analyzer       # vitest
```

**両側変更 / 横断 JSON 契約を触ったとき / PR 前最終確認**:
```bash
mise run check    # Python + TypeScript の全検証を一括実行
```

### Step 6: 結果の集約・修正

- 依存方向違反・型エラー・Lint 違反があれば修正
- 横断 JSON 契約を触った場合は両側のテストが PASS することを必ず確認
- `mise run check` が PASS しない状態で PR は出さない

---

## チェック項目が SKILL.md にない理由

チェック項目 (何を検証するか) は `ai-guide/architecture/` 側で一元管理する。SKILL.md に複製すると、ai-guide を更新したときに SKILL.md 側が置き去りになり、漏れが発生する (drift)。本 skill は「手順 + マッピング + 検証コマンド + 機械検証スクリプト」のみを持つ責務分離にしている。

ルールを追加・変更したいときは `ai-guide/architecture/` を編集すればよく、SKILL.md の更新は不要（機械検証項目を追加するときだけ `scripts/check-arch-conventions.sh` に追記）。
