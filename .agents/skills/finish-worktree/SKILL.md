---
name: finish-worktree
description: worktree内での作業が完了した後、tmpディレクトリ（plan.md・prompt.md）をmainリポジトリへ移管し、worktreeを削除して後片付けする。コミットは /commit スキルで事前に済ませておくこと。
argument-hint: [作業スラッグ]
---

# finish-worktree スキル

worktree内の作業完了後に後片付けを行います。
コミット・プッシュは `/commit` スキルで事前に完了させてから実行してください。

## 使用方法

```
/finish-worktree [作業スラッグ]
```

引数を省略した場合は現在のブランチ名から自動推定します（例: `feature/add-auth` → `add-auth`）。

## 前提条件

- コミット・プッシュが完了していること（`/commit` スキル使用）
- worktree 内のセッションから実行すること
- `jq` がインストール済みであること

## 作業フロー

### Step 0: 事前チェック

未コミット・未プッシュの変更があると作業内容が失われる可能性があるので必ず確認する。

```bash
# 未コミット変更チェック
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: 未コミットの変更があります。/commit を実行してください" >&2
  exit 1
fi

# 未プッシュ commit チェック
if ! git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
  echo "Error: upstream が設定されていません。push してください" >&2
  exit 1
fi
if [[ "$(git rev-list --count @{u}..HEAD)" -gt 0 ]]; then
  echo "Error: 未プッシュの commit があります。/commit で push してください" >&2
  exit 1
fi
```

### Step 1: 作業スラッグ・ディレクトリ・ORIGINAL_REPO_DIR の解決

```bash
# 引数 or branch 名から推定（feature/foo → foo）
SLUG="${1:-$(git branch --show-current | sed 's|.*/||')}"

# worktree のトップディレクトリを取得（サブディレクトリから実行されてもOK）
WORKTREE_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$WORKTREE_DIR" ]]; then
  echo "Error: git worktree のトップを特定できません。worktree 内から実行してください" >&2
  exit 1
fi

# ORIGINAL_REPO_DIR が未設定なら git worktree list から自動検出
if [[ -z "${ORIGINAL_REPO_DIR:-}" ]]; then
  ORIGINAL_REPO_DIR=$(git worktree list --porcelain \
    | awk '/^worktree /{print $2; exit}')
fi

if [[ -z "$ORIGINAL_REPO_DIR" ]] || [[ "$ORIGINAL_REPO_DIR" == "$WORKTREE_DIR" ]]; then
  echo "Error: main worktree を特定できません。/finish-worktree は worktree 内から実行してください" >&2
  exit 1
fi
```

### Step 2: tmp を main リポジトリへ移管

```bash
RESULT=$("$ORIGINAL_REPO_DIR/.agents/skills/finish-worktree/save-worktree-tmp.sh" \
  "$SLUG" "$WORKTREE_DIR" "$ORIGINAL_REPO_DIR")

# 移送先一覧を取得
echo "$RESULT" | jq -r '.saved_dirs[]'
```

スクリプトの挙動:
- worktree の `tmp/` 直下にある `NNNN_*` 形式のディレクトリは個別に main 側 tmp/ に再採番して `mv` する（元の slug は保持）
- 連番でないファイル/ディレクトリが残っていれば、まとめて新しい `NNNN_<SLUG>/` に `mv` する
- 出力 JSON は常に `{"saved_dirs": [...]}` 形式

### Step 3: worktree 削除 + ベストエフォート tmux window close

`cleanup-worktree.sh` を **単一の Bash 呼び出しで** 実行する。
削除後は worktree のディレクトリが消えるため、複数ステップに分けない。

```bash
"$ORIGINAL_REPO_DIR/.agents/skills/finish-worktree/cleanup-worktree.sh" \
  "$WORKTREE_DIR" "$ORIGINAL_REPO_DIR"
```

スクリプトの挙動:
1. `.tmux-window` を読み取り（worktree 削除前に）
2. `cd $ORIGINAL_REPO_DIR` で cwd を退避
3. `git worktree remove $WORKTREE_DIR`
4. ベストエフォートで `tmux kill-window` を試行
   - 成功 → 数秒後に window（＝この worktree セッション）が閉じる。自 window を即時 kill すると出力が途切れるため遅延バックグラウンドで閉じる
   - 失敗 / `.tmux-window` 無し → 「完了しました。この window は手動で閉じてください。」を出力

## 完了後

- `$ORIGINAL_REPO_DIR/tmp/` 以下に作業内容が連番で保存される
- worktree ディレクトリが削除される
- tmux window が自動 close されたか、ユーザーが手動で閉じる

**注意**: window を手動で閉じる場合、Claude を `/exit` で抜けると親 shell が削除済みディレクトリに取り残される（`pwd` が無効）。window ごと閉じる（`prefix &`）のが最もきれいです。
