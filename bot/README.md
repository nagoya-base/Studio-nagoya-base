# X (Twitter) 自動投稿ボット — セットアップガイド

Studio Nagoya Base の X/Twitter アカウントに定期投稿するスクリプトです。
アカウント凍結（サスペンション）リスクを下げるための対策を組み込んでいます。

---

## 凍結リスク対策一覧

| 対策 | 内容 |
|---|---|
| 1日の投稿上限 | 1日最大 **3件** まで（`MAX_POSTS_PER_DAY`） |
| 投稿間隔の確保 | 前回投稿から最低 **4時間** 経過しないと投稿しない（`MIN_INTERVAL_HOURS`） |
| ランダム遅延 | GitHub Actions のスケジュールが来ても最大 **30分** ランダムに待機してから投稿（機械的なパターンを隠す） |
| 重複投稿の禁止 | 同じ本文（SHA-256 ハッシュ）は二度と投稿しない |
| センシティブフラグ | R18 投稿は `sensitive: true` を付け、メディアに `adult_content` メタデータを付与 |
| レートリミット対応 | 429 エラー時は指数バックオフ（1分 → 2分 → 4分）でリトライ |
| 公式 API 使用 | スクレイピング不使用。Twitter API v2 + v1.1 メディアアップロードを使用 |

---

## 必要なもの

- Python 3.11 以上
- X Developer アカウント（Essential アクセス以上）
- リポジトリシークレット（後述）

---

## X Developer Portal でのセットアップ

1. [developer.twitter.com](https://developer.twitter.com/) でアプリを作成
2. **Read and Write** 権限を付与
3. 以下の認証情報を取得:
   - API Key（Consumer Key）
   - API Secret（Consumer Secret）
   - Access Token
   - Access Token Secret

---

## GitHub Secrets の設定

リポジトリの **Settings → Secrets and variables → Actions** に以下を登録:

| Secret 名 | 内容 |
|---|---|
| `X_API_KEY` | API Key (Consumer Key) |
| `X_API_SECRET` | API Secret (Consumer Secret) |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

---

## 投稿内容の追加・編集

`bot/posts.yaml` を編集します。

```yaml
scheduled_posts:
  - text: |
      投稿本文（ハッシュタグ含む）
      #コスプレ #名古屋
    sensitive: false   # R18 投稿は true に
    images:
      - ../images/sample.jpeg  # bot/ ディレクトリからの相対パス
```

- 同一 `text` は重複として自動スキップされます。
- `images` は最大 4 枚まで指定可能（省略時はテキストのみ）。
- `sensitive: true` を付けると X のセンシティブコンテンツとして処理されます。

---

## ローカルでのテスト

```bash
cd bot
pip install -r requirements.txt
export X_API_KEY=xxxx
export X_API_SECRET=xxxx
export X_ACCESS_TOKEN=xxxx
export X_ACCESS_TOKEN_SECRET=xxxx

# 実際には投稿せず、内容だけ確認する
python x_poster.py --dry-run
```

---

## GitHub Actions によるスケジュール実行

`.github/workflows/x-post.yml` に定義された cron スケジュールで自動実行されます。  
デフォルト: **JST 9:00 / 13:00 / 19:00**（それぞれ UTC で実行）

スケジュールを変更したい場合は `x-post.yml` の `cron` 行を編集してください。

---

## 投稿ログ

`bot/post_log.json` に投稿履歴が記録されます。  
GitHub Actions ではワークフロー終了時に自動 commit・push されます。

---

## 注意事項

- X の利用規約を遵守してください。スパム・誤情報・差別的コンテンツの投稿は禁止です。
- R18 コンテンツは必ず `sensitive: true` を設定し、X のコミュニティガイドラインを確認してください。
- API の無料プランには月間 500 ツイートの上限があります（2024年時点）。
