# 実装計画を Discord から読む

実装計画 (`plans/<名前>/*.md`) を **GitHub に入れないまま**、Discord のスレッドに貼った
URL 1 本で読めるようにする仕組み。

## 使う側から見た形

クラウドセッションが計画を書き終えたら、こうする。

```sh
.claude/scripts/publish-plan.sh KANATA-0123456789abcdef plans/github-link
# → https://kanata.linto-dev.workers.dev/p/5aa03867a14bae849ed671d4c5fb1ba5/
```

出た URL を `ask_human` の問いかけに貼る。依頼者はスマホからそれを開いて読み、
**スレッドに「ここを直して」と書く**。直したら同じコマンドをもう一度実行する —
**URL は変わらない**ので、貼り直しは要らない。

## 1 つ増やすときにやること (対象リポジトリ側)

1. `repo-template/.claude/scripts/publish-plan.sh` をリポジトリの同じ場所へ commit する
2. リポジトリの `.gitignore` に **`/plans/`** を足す (先頭の `/` を落とすと、`src/plans/` の
   ような同名のディレクトリまで巻き込む)
3. cloud environment の環境変数 (`KANATA_URL` / `KANATA_TOKEN`) は **既にあるものをそのまま
   使う**。足すものは無い

3 番目がこの作りを選んだ理由でもある。gist なら GitHub のトークン、`wrangler` 直叩きなら
Cloudflare の API トークンが増え、欠けたときの症状は例によって «計画が出てこない» で
同じに見える (CLAUDE.md §6)。

## なぜ Discord にそのまま出さないのか

計画は «相互リンクした複数の markdown» で、実測で 7 ファイル / 231,647 バイトある。

| 出し方 | 何が起きるか |
| --- | --- |
| メッセージに書く | 1 通 2,000 字なので **120 通以上**に割れる |
| `.md` を添付する | 容量は足りるが Discord は素のテキストとしてしか出さない。**表が読めない** |
| Claude Artifact | 単一ページ・相対リンク不可なので、7 ファイルの相互リンクが死ぬ |

## なぜツールではなくシェルなのか

**MCP ツールの引数に本文を載せると、その 231KB を Claude が再出力することになる。**
`publish-plan.sh` は `kanata-hook.sh` と同じく `curl` でバイト列をそのまま送るので、
本文はモデルの出力を 1 バイトも通らない。Claude が読むのは最後の URL の 1 行だけ。

## URL は «その文書を開ける鍵»

`/p/<32hex>/` の 32hex (128bit) を知っていれば誰でも読める。ログインは挟んでいない
(利用者判断)。その代わり、**URL が外へ出ていく口を塞いである**:

| ヘッダ | 何のため |
| --- | --- |
| `Referrer-Policy: no-referrer` | 計画の中の外部リンクを踏んでも、Referer に URL を載せない |
| `X-Robots-Tag: noindex, nofollow` | 検索に載せない |
| `Cache-Control: private, no-store` | 中間に残さない |
| `Content-Security-Policy: default-src 'none'` | スクリプトを動かさない |

**Discord にリンクを貼ると、Discord のプレビュー bot がページを取りに来る。** それが
嫌なら `<URL>` のように山括弧で囲む (Discord がプレビューを出さなくなる)。

`plan_id` は URL に載る以上 **Workers のログにも残る**。取り消したいときは R2 の
オブジェクトを消す (`wrangler r2 object delete`)。鍵を「無効にする」口は持っていない。

## 中で何が起きているか

```txt
PUT  /plans/<slug>/<path>   Bearer + X-Kanata-Session  → R2 に置く
POST /plans/<slug>/finish   同上                        → 余りを消して URL を返す
GET  /p/<plan_id>/<path>    公開                        → markdown を HTML にして返す
```

- **どの計画かは «スレッド × 名前» で決まる。** セッションが落ちて起こし直されても
  (CLAUDE.md §5.5)、同じスレッドの同じ名前なら同じ URL に上書きされる
- 本文は **R2**、台帳 (どのスレッドのどの名前がどの `plan_id` か) は **D1**。
  計画は 1 ファイル 40KB を超えるので、D1 の «SQL 文 100KB» と綱渡りにしない
- `finish` で **今回置かなかったファイルが消える**。名前を変えた古い計画が並びに残らない
- 描画は `marked` + 自前のレンダラ (`domain/markdown.ts`)。
  **生 HTML は必ずエスケープする** — 計画には `<URL>` `<string>` のような山括弧を含む
  地の文があり、素通しにするとブラウザが飲み込んで本文がそこだけ消える
- 見出しの id は **GitHub と同じ slug**。`[§3.1](#31-キーが-confluence-と違う)` のような
  内部リンクがそのまま生きる
- **相対リンクは書き換えない。** `/p/<id>/README.md` から `./phase-01.md` は
  `/p/<id>/phase-01.md` に解決される

## 困ったとき

| 症状 | 見るところ |
| --- | --- |
| `KANATA_URL が環境変数にありません` | routine が別の環境を向いている (docs/new-project.md) |
| `置けませんでした (401)` | `KANATA_TOKEN` が本番の secret とズレている |
| `置けませんでした (404)` | `session_key` が違う。指示文の 1 行目の値をそのまま渡す |
| `置けませんでした (400)` | ファイル名に使えない文字がある (英数字・`.`・`_`・`-` だけ) |
| URL を開くと «見つかりません» | 計画を消したか、`plan_id` が違う |
| 表が崩れる / 本文が消える | `domain/markdown.ts` の描画。生 HTML のエスケープを疑う |
