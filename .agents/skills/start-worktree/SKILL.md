---
name: start-worktree
description: git worktreeで新しいフィーチャーブランチを作成し、cmux 環境ではmise run setup-dataset実行後に右ペインでClaudeを起動する。それ以外（Warp など）では worktree 作成までを行い、新しいペインで実行するコマンドを案内する。ブランチを切って実装を始めたい、worktreeでfeatureを開発したいときに使う。
argument-hint: <ブランチ名 または 実装したい機能の説明>
---

# start-worktree スキル

git worktreeで分離した作業環境を作ります。
- **cmux 環境**: 右ペインに新しいClaudeセッションを自動起動する。
- **それ以外（Warp など）**: worktree の作成までを行い、「新しいペイン/タブ/ウィンドウで実行するコマンド」を表示する（ペイン操作はしない）。表示されたコマンドを自分で実行してください。

計画・実装は起動後のセッション内で `/start-implementation` を使って行います。

## 使用方法

```
/start-worktree <ブランチ名 または 実装したい機能の説明>
```

## 作業フロー

### Step 1: ブランチ名の決定

引数がブランチ名の形式（英数字・スラッシュ・ハイフンのみ）であればそのまま使用する。
そうでなければ、引数の内容から適切なブランチ名を生成する（確認は取らない）：

- `feature/` / `fix/` / `chore/` / `refactor/` などのプレフィックスを判断して付ける
- 残りの部分は英語で簡潔なハイフン区切りにする（例: `add-auth`, `fix-login-bug`）

### Step 2: Worktreeの作成

```bash
.claude/skills/start-worktree/create-worktree.sh "<ブランチ名>"
```

JSONから `worktree_dir` / `original_dir` / `branch` を取得する。

### Step 3: 新しいClaudeセッションの起動 / 案内

```bash
.claude/skills/start-worktree/open-in-terminal.sh "<worktree_dir>" "<original_dir>"
```

- **cmux 環境**: `open-in-cmux.sh` に委譲し、右ペインで `SETUP_COMMANDS`（`mise run setup-dataset`。setup に depends するので submodule update + Python/mb-analyzer 依存も内包し、加えて dataset vendor の node_modules を再生成する。これを欠くと integration テストが setup-failure → error になる）実行後に Claude を起動する
- **それ以外**: 新しいペインで実行すべきコマンド（`cd "<worktree>" && <setup> && claude`）を表示する（macOS ならクリップボードにもコピーする）。スキルはこの出力をそのままユーザーに見せる
- `WORKTREE_TERMINAL=cmux|manual` を環境変数で渡すと判別を上書きできる
- 起動後のセッションで `/start-implementation` を使って計画・実装を行う

## 前提条件

- **cmux で実行する場合**: cmux のウィンドウ内で実行し、`cmux` と `jq` がインストール済みであること（右ペインに新セッションを開く）
- **それ以外（Warp など）**: 前提なし。表示されたコマンドを手動で別のペイン/タブ/ウィンドウで実行する
