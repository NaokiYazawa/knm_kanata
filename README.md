# knm_kanata

**Discord から、リモートで走る Claude Code に指示を出すための個人用ブリッジ。**
Cloudflare Workers + D1 だけで動く。手元のマシンも Raspberry Pi も要らない。

指示を投げると Anthropic のクラウド VM で Claude Code のセッションが立ち上がり、
判断が要るところで **Discord にボタンとフォームで聞きに来る**。答えるとその場で続きが走る。
ターミナルの `AskUserQuestion` と同じ体験を、スマホから受け取れる。

```
/claude 「認証まわりをリファクタして」
        │
        ▼
  Cloudflare Worker ──POST /v1/claude_code/routines/{trig}/fire──▶ Anthropic 管理 VM
        ▲                                                              │
        │  ❓ 確認したいことがあります                                  │ .mcp.json
        │  [ A案 ] [ B案 ] [ ✍️ 自由に書く ]  ◀── ask_human ────────────┘
        │  … 進行中 / ✅ 完了 (PR のリンク)  ◀── report ────────────────┘
        └── Discord のスレッド
```

## なぜこの形か

Claude Code on the web には **走っているセッションへ外から発言を差し込む公式 HTTP API が無い**。
なので «話しかける» のを諦めて、**セッション側から聞きに来させる**。Worker 自身が MCP サーバーになり、
対象リポジトリの `.mcp.json` 経由で `ask_human` / `report` を生やす。ツール呼び出しは Claude の
turn を止めるので、人が答えるまで待たせられる。

課金もこの形にした理由になっている。2026-06-15 以降、**`claude -p` と Agent SDK はサブスク枠から
外れ**、月 $20〜200 の Agent SDK クレジット (API 定価・繰越なし) から引かれる。一方
**cloud session (Claude Code on the web / routines) はサブスク席の枠のまま**で、VM の計算課金もゼロ。
だから «自前のコンテナで `claude -p`» ではなく «routine を起動する» を選んでいる。

Cloudflare 側は Workers Paid の $5/月 に収まる (D1・Worker とも個人利用なら込み枠内)。

## 必要なもの

- Claude の **Pro / Max / Team / Enterprise** で **Claude Code on the web が有効**なこと
  → `claude.ai/code/routines` が開けば OK
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
2. Bot の **Reset Token** で `DISCORD_BOT_TOKEN`、General Information の **Public Key** で
   `DISCORD_PUBLIC_KEY`、**Application ID** で `DISCORD_APPLICATION_ID`
3. **Interactions Endpoint URL** に `https://<worker>/discord/interactions` を入れて保存
   （保存時に Discord が署名検証を試すので、先に Worker をデプロイしておく）
4. OAuth2 → URL Generator で招待。スコープ `bot` + `applications.commands`、
   権限は `Send Messages` / `Create Public Threads` / `Send Messages in Threads` /
   `View Channels`
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

- **Network access** を **Custom** にして **Allowed domains** に Worker のホスト名
  （`kanata.<subdomain>.workers.dev`）を足す。既定の **Trusted** は許可リスト外を `403` で落とすので、
  これをやらないと `ask_human` が繋がらない
- **Environment variables** に
  - `KANATA_URL` = `https://<worker>`
  - `KANATA_TOKEN` = 1 で決めた値

### 5. 対象リポジトリに置くもの

`repo-template/` の中身をコピーして commit する。

| ファイル | 役目 |
|---|---|
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

## まだ確かめていないこと

**2 分を超えるツール呼び出しは自動でバックグラウンドタスクに回る** (Claude Code v2.1.212+) という
仕様があり、`ask_human` の待ちがそこに触れないかは実測が要る。1 回の待ちを **75 秒**に切ってあるのは
それを避けるためだが、初回は «ボタンを押すまで Claude が本当に止まっているか» を必ず目で見ること。
おかしければ `ASK_WAIT_BUDGET_MS` を短くする（`ask_wait` の呼び直し回数が増えるだけで壊れない）。

## 開発

```bash
pnpm test              # vitest (D1 は毎回まっさら)
pnpm run check-types
pnpm run check         # biome
pnpm run dev           # wrangler dev
```

設計・実装のルールは [CLAUDE.md](./CLAUDE.md)。

## この先やること（MVP に入れていない）

- **Discord Gateway の常時接続** — スレッドに素で書いた文章を拾う。`knm_kaname` の
  `apps/server/src/durable-objects/discord-gateway.do.ts` がそのまま使える形になっている
  (outbound WebSocket は hibernation 非対応 / alarm を使う / 5 分 cron の watchdog)
- **複数リポジトリ・スケジュール実行・GitHub イベント連携** — routine 側のトリガを足すだけで届く
- **自己ホスト環境** — runner を Cloudflare Container で動かすと、サブスク課金のまま実行を
  自分の Cloudflare に引き込める。Team/Enterprise の public beta で、Owner が
  `claude.ai/admin-settings/cloud-environments` で有効化する必要がある
