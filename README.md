# knm_kanata

Discord から、リモートで走る Claude Code に指示を出すための個人用ブリッジ。
Cloudflare Workers + D1 だけで動く。手元のマシンも Raspberry Pi も要らない。

指示を投げると Anthropic のクラウド VM で Claude Code のセッションが立ち上がり、判断が要るところで Discord にボタンとフォームで聞きに来る。答えるとその場で続きが走る。
ターミナルの `AskUserQuestion` と同じ体験を、スマホから受け取れる。

```txt
/claude "Refactor the auth layer"
        │
        ▼
  Cloudflare Worker ──POST /v1/claude_code/routines/{trig}/fire──▶ Anthropic-managed VM
        ▲                                                              │
        │  ❓ A question for you                                       │ .mcp.json
        │  [ Option A ] [ Option B ] [ ✍️ Write freely ] ◀── ask_human ┘
        │  … Running / ✅ Done (PR link)  ◀── report ──────────────────┘
        └── Discord thread
```

## なぜこの形か

Claude Code on the web には走っているセッションへ外から発言を差し込む公式 HTTP API が無い。
なので «話しかける» のを諦めて、**セッション側から聞きに来させる**。
Worker 自身が MCP サーバーになり、対象リポジトリの `.mcp.json` 経由で `ask_human` / `report` を生やす。
ツール呼び出しは Claude の turn を止めるので、人が答えるまで待たせられる。

課金もこの形にした理由になっている。
2026-06-15 以降、`claude -p` と Agent SDK はサブスク枠から外れ、月 $20〜200 の Agent SDK クレジット (API 定価・繰越なし) から引かれる。
一方 cloud session (Claude Code on the web / routines) はサブスク席の枠のままで、VM の計算課金もゼロ。
だから «自前のコンテナで `claude -p`» ではなく «routine を起動する» を選んでいる。

Cloudflare 側は Workers Paid の $5/月 に収まる (D1・Worker とも個人利用なら込み枠内)。

## 必要なもの

- Claude の **Pro / Max / Team / Enterprise** で **Claude Code on the web が有効**なこと → `claude.ai/code/routines` が開けば OK
- Cloudflare の **Workers Paid**
- Discord のアプリ (bot) を 1 つ作れること
- 対象リポジトリは **GitHub** (cloud session は GitHub からしか clone できない)

## セットアップ

### 1. Cloudflare

```bash
pnpm install
wrangler d1 create kanata          # 出力の database_id を wrangler.jsonc に貼る
pnpm run db:migrate                # 本番の D1 にスキーマを流す
```

secret を入れる (`PROJECTS_JSON` は 3 で作った routine が要るので後回しでよい):

```bash
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put KANATA_TOKEN     # 自分で決めるランダムな長い文字列
wrangler secret put PROJECTS_JSON
```

`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `OWNER_DISCORD_USER_ID` は秘密ではないので
`wrangler.jsonc` の `vars` に書いてもよい (secret にしても動く)。

```bash
pnpm run deploy                      # https://kanata.<subdomain>.workers.dev が出る
```

### 2. Discord

1. [Developer Portal](https://discord.com/developers/applications) で New Application → Bot
2. Bot の **Reset Token** で `DISCORD_BOT_TOKEN`、General Information の **Public Key** で `DISCORD_PUBLIC_KEY`、**Application ID** で `DISCORD_APPLICATION_ID`
3. **Interactions Endpoint URL** に `https://<worker>/discord/interactions` を入れて保存（保存時に Discord が署名検証を試すので、先に Worker をデプロイしておく）
4. OAuth2 → URL Generator で招待。スコープ `bot` + `applications.commands`、権限は `Send Messages` / `Create Public Threads` / `Send Messages in Threads` / `View Channels`
5. コマンドを登録する:

```bash
cat > .env.local <<'ENV'
DISCORD_APPLICATION_ID=...
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...        # 入れるとそのサーバーだけに即時反映 (グローバルは数分かかる)
PROJECTS_JSON=[...]         # project の選択肢を作るのに使う
ENV
pnpm run commands:register
```

### 3. Anthropic の routine（プロジェクト 1 つにつき 1 本）

1. `pnpm exec node scripts/print-routine-prompt.ts` で貼り付けるプロンプトを出す
2. [claude.ai/code/routines](https://claude.ai/code/routines) → **New routine**
   - **プロンプト**: 1 で出したものをそのまま貼る
   - **リポジトリ**: 対象の GitHub リポジトリ
   - **環境**: 下の 4 で作る環境を選ぶ
   - **トリガー**: **API** を選んで保存
3. 保存後にもう一度開き、**Add another trigger → API → Generate token**。
   URL とトークンをここで控える（トークンは一度しか表示されない）
4. `PROJECTS_JSON` に足す:

```json
[
  {
    "name": "myapp",
    "repoUrl": "https://github.com/me/myapp",
    "fireUrl": "https://api.anthropic.com/v1/claude_code/routines/trig_XXXX/fire",
    "fireToken": "sk-ant-oat01-XXXX"
  }
]
```

### 4. cloud environment（Worker に届かせる）

routine の編集画面 → 環境の設定で:

- **Network access** を **Custom** にして **Allowed domains** に Worker のホスト名（`kanata.<subdomain>.workers.dev`）を足す。
  既定の **Trusted** は許可リスト外を `403` で落とすので、これをやらないと `ask_human` が繋がらない
- **Environment variables** に
  - `KANATA_URL` = `https://<worker>`
  - `KANATA_TOKEN` = 1 で決めた値

### 5. 対象リポジトリに置くもの

`repo-template/` の中身をコピーして commit する。

| ファイル | 役目 |
| --- | --- |
| `.mcp.json` | Worker を MCP サーバーとして繋ぐ。cloud session は **project スコープの `.mcp.json` を確認プロンプト無しで読み込む** |
| `.claude/settings.json` | Stop hook の登録 |
| `.claude/hooks/kanata-stop.sh` | 完了通知の**保険**。Claude が `report(done)` を忘れても終了だけは届く |

```bash
cp -r /path/to/knm_kanata/repo-template/. /path/to/myapp/
git -C /path/to/myapp add .mcp.json .claude && git -C /path/to/myapp commit -m "kanata を繋ぐ"
```

### 6. 動かす

Discord で `/claude task:「READMEのtypoを直してPRを作って」`。
スレッドが立ち、セッションのリンクが出て、Claude が判断に迷うとボタンが飛んでくる。

## 詰まりどころ (実際に踏んだもの)

**① 許可ドメインに入れていないと、MCP の接続失敗が «認証エラー» に化ける。**

```
kanata (AUTH_HEADER_REJECTED): "Server rejected the configured Authorization header (HTTP 403).
… Error detail: request blocked: no rule or allowlist entry allows host kanata.linto-dev.workers.dev"
```

ラベルは «Authorization ヘッダが拒否された» だが、実際は cloud environment の**送信先許可リスト**で
止まっている。**`request blocked: no rule or allowlist` の方を読む**こと。トークンを疑って時間を
落とさない (Worker はトークン不一致なら 401 を返すので、403 はそもそも Worker に届いていない)。
Allowed domains に入れるのは **スキーム無しのホスト名**。

**② routine の `allowed_tools` に MCP ツールが入っていないと、承認待ちで固まる。**

routine を API で作ると `allowed_tools` が既定の一覧で埋まり、そこに `mcp__kanata__*` は入らない。
routine には承認する人がいないので、ログに `permission prompt mcp__kanata__ask_human` が出たまま
進まなくなる。`mcp__kanata` (サーバー単位) と 3 つのツール名を足しておく。

```bash
# 切り分けは «存在しない session_key で ask_human を 1 回だけ呼ばせる» のが速い。
# Discord に触れずに、許可ドメイン・環境変数・MCP 認証・ツール発見・承認まで一度に確かめられる。
```

## 通しで確かめたこと (2026-08-29)

`/claude` から PR 手前まで実機で通した。記録は D1 と routine のログに残っている。

| 経路 | 結果 |
|---|---|
| Discord `/claude` → スレッド作成 → routine 起動 | ✅ |
| cloud session → MCP `report` → Discord のスレッド | ✅ |
| `ask_human` の選択肢ボタン | ✅ |
| `ask_human` の自由記述 (モーダル) | ✅ |
| **`ask_wait` の呼び直しループ (5 分待ち)** | ✅ |
| Stop hook が転写ログの印から実行を特定 | ✅ (`report(done)` が先に来ていれば二重に出さない) |

**待ちの実測 (5 分 19 秒 待たせたとき):**

```
03:11:37  ask_human  → 03:12:53  pending   (76 秒)
03:12:54  ask_wait   → 03:14:09  pending   (75 秒)
03:14:10  ask_wait   → 03:15:18  ERROR 502 Bad gateway (origin_bad_gateway)
03:15:19  ask_wait   → 03:16:34  pending   (75 秒)
03:16:36  ask_wait   → 03:16:59  answered "A案"
```

懸念していた «2 分を超えたツール呼び出しがバックグラウンドへ回る» には**当たらなかった**。
代わりに **75 秒はエッジの限界に近すぎる**ことが分かった (4 回目で 502)。Claude が呼び直して
復帰はしたが、復帰を運に任せないので **1 回の待ちは 45 秒**に縮めてある。短くしても壊れない —
待ち続ける責務は Claude 側のループにあり、1 往復増えるだけで人の体感は変わらない。

## 開発

```bash
pnpm test              # vitest (D1 は毎回まっさら)
pnpm run check-types
pnpm run check         # biome
pnpm run dev           # wrangler dev
```

設計・実装のルールは [CLAUDE.md](./CLAUDE.md)。

## この先やること（MVP に入れていない）

- **Discord Gateway の常時接続** — スレッドに素で書いた文章を拾う。`knm_kaname` の `apps/server/src/durable-objects/discord-gateway.do.ts` がそのまま使える形になっている (outbound WebSocket は hibernation 非対応 / alarm を使う / 5 分 cron の watchdog)
- **複数リポジトリ・スケジュール実行・GitHub イベント連携** — routine 側のトリガを足すだけで届く
- **自己ホスト環境** — runner を Cloudflare Container で動かすと、サブスク課金のまま実行を自分の Cloudflare に引き込める。
  Team/Enterprise の public beta で、Owner が `claude.ai/admin-settings/cloud-environments` で有効化する必要がある
