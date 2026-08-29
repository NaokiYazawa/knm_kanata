# knm_kanata

Discord から、リモートで走る Claude Code に指示を出すための個人用ブリッジ。
Cloudflare Workers + D1 だけで動く。手元のマシンも Raspberry Pi も要らない。

指示を投げると Anthropic のクラウド VM で Claude Code のセッションが立ち上がり、判断が要るところで Discord にボタンで聞きに来る。ボタンを押すか、スレッドにそのまま書けば、その場で続きが走る。
ターミナルの `AskUserQuestion` と同じ体験を、スマホから受け取れる。

**スレッドは 1 本の会話。** 一度スレッドが立ったら、あとは **素で書くだけ**でいい。
セッションは作業が終わっても終了せず、`ask_human` で「次は？」と聞いて待つ。そこへ書いた文が同じセッションの同じ文脈へそのまま届く。
「おわり」と言うまで終わらない。待っている間は 1 つのツール呼び出しを SSE で握っているだけなので、**トークンを消費しない**。

作業中に書いた文は消えない。👀 が付いて預かられ、Claude が次に聞きに来たときにまとめて渡る (ターミナルの Claude Code で作業中に打った文が次のターンで届くのと同じ)。
渡ると ✅ に変わる。

```txt
/claude "Refactor the auth layer"
        │
        ▼
  Cloudflare Worker ──POST /v1/claude_code/routines/{trig}/fire──▶ Anthropic-managed VM
        ▲     ▲                                                        │
        │     │  ❓ A question for you                                 │ .mcp.json
        │     │  [ Option A ] [ Option B ]  ← or just type in the thread ── ask_human ┘
        │     │  … Running / ✅ Done (PR link)  ◀── report ────────────┘
        │     └── Discord thread
        │
        └── Durable Object ══ WebSocket ══ Discord Gateway
              (a plain message you type in the thread comes in here)
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

**Cloudflare のアカウントを複数持っているなら、プロファイルを package.json に固定する。**
`deploy` / `db:migrate` / `projects:push` の 3 つに `--profile` を書いてあります（既定は `linto`）。
別のアカウントで動かすなら、この 3 か所を書き換えてください。

固定していないと `pnpm run deploy` は **`wrangler whoami` が出す既定アカウント**へ向かいます。
D1 が無ければ `D1 binding 'DB' references database '…' which was not found` で落ちますが、
**secret を送る `projects:push` の方は落ちずに通ってしまい、routine の fire トークンが意図
しないアカウントの Worker に入ります**（実際に入りました）。

コマンドラインから付け足すときは `pnpm exec` を使ってください。
`pnpm run deploy -- --profile x` は `--` が wrangler へそのまま渡るので**効きません**
（`wrangler deploy -- --profile x` になり、プロファイルは無視されます）。

### 2. Discord

1. [Developer Portal](https://discord.com/developers/applications) で New Application → Bot
2. Bot の **Reset Token** で `DISCORD_BOT_TOKEN`、General Information の **Public Key** で `DISCORD_PUBLIC_KEY`、**Application ID** で `DISCORD_APPLICATION_ID`
3. **Interactions Endpoint URL** に `https://<worker>/discord/interactions` を入れて保存（保存時に Discord が署名検証を試すので、先に Worker をデプロイしておく）
4. Bot ページの **Privileged Gateway Intents** で **MESSAGE CONTENT INTENT** を on にする。
   **これが無いと Gateway が close 4014 で切られ、素の文を一切拾えない**（本文が空で届くのではなく、接続そのものが張れない）。
   ユニークユーザー 10,000 人未満のアプリは Portal のトグルだけでよく、審査も申請も要らない
5. OAuth2 → URL Generator で招待。スコープ `bot` + `applications.commands`、権限は `Send Messages` / `Create Public Threads` / `Send Messages in Threads` / `View Channels` / `Add Reactions`（最後の 1 つは «預かった / 渡した» の印に使う）
6. コマンドを登録する:

```bash
cp .env.example .env.local   # 各鍵の意味と PROJECTS_JSON の書き方はこのファイルにある
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
  - `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` = `0`
    （**必須**。無いと `ask_human` が 2 分でバックグラウンドに回され、Claude が答えを待たずに先へ進む）
  - `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` = `3600000`
    （**必須**。Claude Code は v2.1.187 以降、応答も progress 通知も無いまま **5 分**経った
    リモート MCP ツール呼び出しを打ち切る。既定 5 分・公式ドキュメント未記載で、
    症状は「**5 分 00 秒ちょうどで握りが落ちる**」。`ASK_HOLD_MS`（既定 15 分）より大きくする）

### 5. 対象リポジトリに置くもの

`repo-template/` の中身をコピーして commit する。

| ファイル | 役目 |
| --- | --- |
| `.mcp.json` | Worker を MCP サーバーとして繋ぐ。cloud session は **project スコープの `.mcp.json` を確認プロンプト無しで読み込む** |
| `.claude/settings.json` | hook の登録（`PreToolUse` / `Stop` / `SessionEnd`） |
| `.claude/hooks/kanata-hook.sh` | コンテキスト残量の通報と、完了通知の**保険** |

```bash
cp -r /path/to/knm_kanata/repo-template/. /path/to/myapp/
git -C /path/to/myapp add .mcp.json .claude && git -C /path/to/myapp commit -m "kanata を繋ぐ"
```

### 6. 動かす

Discord で `/claude task:「READMEのtypoを直してPRを作って」`。
スレッドが立ち、セッションのリンクが出て、Claude が判断に迷うとボタンが飛んでくる。

**そのあとは、スレッドに素で書くだけ。** `/claude` はもう要らない。

## スレッドの中で何が起きるか

素の文の扱いは 4 通りしかない。判定は `src/domain/inbound.ts` が 1 つだけ持っている。

| そのとき Claude は | 書いた文は | 見え方 |
| --- | --- | --- |
| 質問を出して待っている | **回答**になる | 質問からボタンが消え、`→ 書いた内容` が付く |
| 作業中 | **預かられる** | 👀 が付く。渡ったら ✅ に変わる |
| 終わっている / 落ちている | **新しいセッションの指示**になる | 「🔁 新しいセッションを起こしました」が出る（記憶は引き継がない） |
| そもそも kanata の会話ではない | **何も起きない** | 何も出さない（雑談がそのまま Claude へ流れる事故を作らない） |

親チャンネルに書いた文は拾わない。**起動は `/claude` だけ**。

### Gateway の様子を見る

素の文は HTTP では受け取れないので、Durable Object が 1 つ Discord Gateway への WebSocket を
持ち続けている。詰まったらここを見る:

```bash
curl -H "Authorization: Bearer $KANATA_TOKEN" https://<worker>/gateway/status
# {"state":"live","healthy":true,"fatalReason":null,"lastEventAt":...,"connected":true}

curl -X POST -H "Authorization: Bearer $KANATA_TOKEN" https://<worker>/gateway/reset
```

`state` が `fatal` のときは `fatalReason` に直し方が書いてある（token が違う / intent が
有効になっていない）。**直らない失敗では自動で張り直さない** — 張り続けると identify の
レート制限（1 日 1000 回）を静かに使い切るので、設定を直したら `reset` を叩く。

コストは Workers Paid の含有枠の内側に収まる。outbound WebSocket は hibernation 非対応なので
繋いでいる間ずっと課金されるが、`128MB × 30 日 = 約 324,000 GB-s` で含有 400,000 GB-s を超えない。
**そのぶん常駐 DO を 2 つにすると枠を超える**ので、この DO はシングルトンにしてある。

## 待ちのコスト (実測 2026-08-29)

16.6 分待たせたときの実際の記録:

```txt
04:26:01  ask_human  ──────── 15 分 01 秒 握り続けた ────────▶ 04:41:03  pending
04:41:05  ask_wait   ──── 1 分 37 秒 ────▶ 04:42:42  answered「合言葉は？」
04:42:44  「合言葉は『紫陽花』です」        ← 17 分前に伝えた言葉を保持
```

**16.6 分の待ちで turn は 2 回だけ。** 45 秒周期のポーリングなら 22 turn だったので 11 分の 1。
502 もバックグラウンド化も起きず、progress 通知も 37 回流れた。turn が増えるのは «握りの上限
(`ASK_HOLD_MS`、既定 15 分) に達したとき» だけなので、伸ばせばさらに減る。

## 1 チャンネル = 1 プロジェクト = 1 リポジトリ

**リポジトリはモノレポ 1 本**を前提にしています。そうすると全部が一直線に並びます。

```txt
Discord チャンネル  ──  プロジェクト  ──  routine  ──  GitHub リポジトリ
   #alpha                 alpha          trig_…        NaokiYazawa/alpha
```

紐付けを持つのは `PROJECTS_JSON` (Worker の secret) だけです。**管理画面は要りません。**

```json
[
  {
    "name": "alpha",
    "channelId": "1543…",
    "repoUrl": "https://github.com/NaokiYazawa/alpha",
    "fireUrl": "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire",
    "fireToken": "sk-ant-oat01-…"
  }
]
```

プロジェクトを 1 つ増やす手順は **[docs/new-project.md](./docs/new-project.md)** にまとめてあります
（Discord のチャンネル作成から、モノレポ / 複数リポジトリの分かれ道まで）。要は 3 つです。

1. claude.ai でそのリポジトリの routine を作り、API トリガのトークンを発行する
2. Discord にチャンネルを 1 つ作り、ID をコピーする（開発者モード → チャンネル右クリック）
3. `projects.json` に 1 要素足して `pnpm run projects:push -- --profile linto`

`projects.json`（gitignore 済み）が**正本**です。secret は読み出せず、`wrangler secret put` は
値を丸ごと置き換えるので、手元に全文が無いと既存のプロジェクトが消えます。
`pnpm run projects:push -- --dry-run` で何を送るか先に見られます。

`#alpha` で `/claude` を叩けば alpha に飛びます。スレッドの中で叩いても親チャンネルで照合します。

`#alpha` で `/claude` を叩けば、プロジェクト名を書かなくても alpha に飛びます。スレッドの中で
叩いても親チャンネルで照合します。**どこにも結び付いていない場所では黙って選ばず**、使える
名前を返します（雑談チャンネルの `/claude` が本番リポジトリに飛ぶ事故を作らないため）。

起動メッセージにはリポジトリが出ます（`repoUrl` から作るので、書くのは 1 行だけです）。
これは**このセッションが触れる範囲**そのものだからです。

## モノレポ前提を崩すとどうなるか

以下は「1 プロジェクトに 2 本以上のリポジトリ」を入れたくなったときのための記録です。
**モノレポで回している限り、この節は読まなくて構いません。**

### セッションが触れる範囲は `sources` が境界（実測）

| 試したこと | 結果 |
| --- | --- |
| `credential.helper` | **未設定** |
| 公開リポジトリを `git clone` | OK |
| **非公開リポジトリを `git ls-remote`** | **NG** |
| clone 済みリポジトリへ `git push --dry-run` | OK |
| `mcp__github__*` | 見えるが **sources にスコープされ、他リポジトリは拒否**される |

つまり「主リポジトリ 1 本だけ source に入れて、他は会話の中で clone する」は**成立しません**。
2 本目が要るなら `sources` に入れるしかありません。そして次の問題が出ます。

### 複数リポジトリのときは setup script が要る

リポジトリを 2 本以上入れると **作業ディレクトリがリポジトリの外へ上がります**（実測）。

```txt
1 本 … cwd = /home/user/knm_kanata   → リポジトリの .mcp.json が読まれる
2 本 … cwd = /home/user              → 読まれない（mcp__kanata__* が消える）
```

プロジェクトスコープの `.mcp.json` と `.claude/settings.json` は**作業ディレクトリ**から読まれる
ので、commit してあっても届きません。**ask_human も report も使えなくなります。**
（スキルは無事でした。壊れるのは「プロジェクトルートから読む設定」だけです。）

塞ぐには [`cloud-setup.sh`](./cloud-setup.sh) を cloud environment の **Setup script** に貼ります。
**モノレポで回すなら貼る必要はありません**（貼ったままだと同じフックが 2 回走りうるので、
使わないなら外しておくのがよいです）。
**中身はどのプロジェクトでも同じ**なので、環境に 1 回貼れば以後は routine にリポジトリを
並べるだけです。貼った後の実測:

```txt
Running setup script → Setup script completed
/home/user/.mcp.json                     あり
/home/user/.claude/settings.json         あり  hooks: PreToolUse / Stop / SessionEnd
mcp__kanata__ask_human / ask_wait / report   見えている   ← 復活
コンテキスト残量が D1 に届いた              61,506 トークン
```

### routine の上限

| | |
| --- | --- |
| routine の**数** | 文書化された上限なし |
| 1 日に**走らせられる回数** | アカウント単位の日次キャップ（正本は [claude.ai/code/routines](https://claude.ai/code/routines)） |
| API トークン | **routine ごとに web UI で手で発行**（*"There is no public API for token management."*） |

日次キャップは「routine の数」ではなく「起動した回数」に効きます。kanata はスレッドを 1 本の
セッションで回し続けるので、**1 日ぶんの会話が 1 回**にしかなりません。

## スキル (Agent Skills)

**リポジトリに commit したスキルは、クラウドセッションでそのまま使えます。**

```txt
.claude/skills/<name>/SKILL.md   → commit して push するだけ
```

[公式ドキュメントの「What carries over from your setup」](https://code.claude.com/docs/en/cloud-environments)に
`Your repo's .claude/skills/, .claude/agents/, .claude/commands/` → **Yes (Part of the clone)** と
明記されています。routine の `allowed_tools` に `Skill` が入っていることだけ確認してください
（API で作った routine には既定で入ります）。

### 複数のリポジトリで共通に使いたいとき

| 方法 | 効き方 | 注意 |
| --- | --- | --- |
| **claude.ai のアカウントで有効化** | 全リポジトリ・全 routine に自動で届く | Anthropic 経由なので**許可ドメイン不要**。リポジトリ側の設定も不要 |
| リポジトリの `.claude/settings.json` でプラグイン宣言 | マーケットプレイス 1 本を各リポジトリから参照。git で版管理できる | セッション開始時にインストールするので、**マーケットプレイスのホストを Allowed domains に足す**必要がある |

**効かないもの**（同じ表より）:

| `~/.claude/skills/`（手元のマシン） | **No** — *"Live on your machine, not in the repo"* |
| --- | --- |
| ユーザー設定だけで有効化したプラグイン | **No** — リポジトリの `.claude/settings.json` で宣言するか、claude.ai で有効にする |

**同名のときの優先順位に注意。** リポジトリのスキルは claude.ai 同期スキルを**上書き**します
（*"A skill or command from any of these sources overrides a skill synced from your claude.ai
account with the same name"*）。一方 `~/.claude/skills/` はローカルでは project より強いのに
クラウドでは読まれないので、**手元とクラウドで挙動が変わる**組み合わせになります。

### 実測 (2026-08-29)

疎通確認用に `.claude/skills/kanata-selftest/` を置いてあります。実際にクラウドセッションで
走らせた結果:

```txt
--- プロジェクト (このリポジトリ) ---
kanata-selftest                        ← commit したスキルが読まれている
--- 個人 (~/.claude/skills) ---
session-start-hook
synced                                 ← claude.ai のスキルが同期されて置かれる
--- claude.ai 同期の置き場 (~/.claude/skills/synced) ---
46729bd0-…_c6ca81c6-…
--- プラグイン ---
synced                                 ← synced plugins も届いている
```

**合言葉が返ってきた**ので、一覧に名前が出ているだけでなく **SKILL.md の本文が届いている**
ことまで確認できました（説明文だけなら一覧に出て本文は読まれません）。呼び出しは `Skill`
ツール経由で、4 ターン・16 秒で完了しています。

そのセッションから呼べたスキルには、claude.ai 側で有効にしてあるものも並んでいました
（`requirements-definition` / `morning` / `import-memory` など）。**claude.ai アカウントの口が
クラウドセッションに効いている**ことの実測です。

なお **「Claude が説明文を見て自分で選ぶ」経路はまだ実測していません**（この確認では名指し
しました）。仕様上は `description` で自動選択されます。

## コンテキストの残量

Claude の発言の末尾に、そのときの使用量が小さく付きます。

```txt
kanata
実装が終わりました。次は？
▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 62% ・124k/200k
  [ おわり ]        ← 「おわり」以外を言いたければ、そのままスレッドに書く
```

**次に何を言うか決めるまさにその場**にあるので、見に行く必要がありません。過去のメッセージは
当時の値のまま残るので、伸び方もそのまま履歴として読めます。

### どこから取っているか

**Claude Code はコンテキスト量を外へ出しません。** どの hook の入力にもトークン数は入って
おらず、ステータスラインは対話 UI 専用でクラウドセッションでは動きません。唯一の出口が
**転写ログ (`transcript_path`) の `message.usage`** なので、hook がそれを読んで Worker へ
送っています（`PreToolUse` = 出す直前 / `Stop` = ターンの終わり）。

分子は[公式のステータスライン](https://code.claude.com/docs/en/statusline)と同じ式です:
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`（**output は含めない**）。

分母は転写ログから読めないので設定で持ちます。既定は 200,000 で、拡張コンテキストのモデルなら:

```bash
wrangler secret put CONTEXT_WINDOW_TOKENS   # 1000000
```

ズレても**生のトークン数を併記する**ので真値は見失いません（分母を超えたらバーは 100% で
止まり、% は 203% のように出ます）。

**1 つ古いことがあります。** 転写ログは非同期に書かれるので、hook が走った時点で最新の
メッセージがまだ載っていないことがある、と公式ドキュメントに明記されています。桁を見るには
十分、という前提で読んでください。

### 出す場所を «発言の末尾» にした理由

| 候補 | なぜ使わないか |
| --- | --- |
| スレッド名 | Discord の**チャンネル名変更は 2 回 / 10 分**で、毎ターン更新できない |
| スレッド先頭の起動メッセージ | 更新はできるが、**見るのに上までスクロールが要る** |
| 別メッセージで通知 | 会話が bot の相槌で埋まる |

## 握りは落ちる (落ちても失わない)

壁を全部外しても transport は落ちる。実測では **15 分 01 秒**と **6 分 22 秒**は握れたのに、
別の回は **5 分 00 秒**で切れた。時間では説明が付かないので、こちらでは防げない。

落ちたとき Claude に届くのは `transport dropped mid-call` という **`ask_id` を含まない**
エラーで、`ask_wait` では拾い直せない。だから `ask_human` を **セッション単位で冪等**にしてある:

| 呼び直したとき | 返るもの |
| --- | --- |
| 切れている間に答えが入っていた | **その答え**（質問は出し直さない） |
| まだ未回答 | 同じ問いを握り直す（**Discord に 2 通目を出さない**） |
| 未配達の問いが無い | ふつうに新しい問いを立てる |

routine のプロンプトにも「接続エラーで落ちたら `question` は `"(再送)"` の 1 語でよい」と
書いてある。回答を丸ごと作り直させないため。

## 詰まりどころ (実際に踏んだもの)

**① 許可ドメインに入れていないと、MCP の接続失敗が «認証エラー» に化ける。**

```txt
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

**③ `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` が無いと、待ちが壊れる。**

Claude Code は **2 分を超えたツール呼び出しをバックグラウンドタスクへ回す** (v2.1.212+)。
*「Claude receives the task ID immediately and keeps working」* なので、`ask_human` が握って
いる最中に Claude が先へ進む。Worker 側は正しく握れているのに壊れるので気づきにくい。

```bash
# 切り分けは «存在しない session_key で ask_human を 1 回だけ呼ばせる» のが速い。
# Discord に触れずに、許可ドメイン・環境変数・MCP 認証・ツール発見・承認まで一度に確かめられる。
```

## 通しで確かめたこと (2026-08-29)

`/claude` から PR 手前まで実機で通した。記録は D1 と routine のログに残っている。

| 経路 | 結果 |
| --- | --- |
| Discord `/claude` → スレッド作成 → routine 起動 | ✅ |
| cloud session → MCP `report` → Discord のスレッド | ✅ |
| `ask_human` の選択肢ボタン | ✅ |
| 選択肢に無い答えを **スレッドに素で書く** | ✅ |
| **`ask_wait` の呼び直しループ (5 分待ち)** | ✅ |
| Stop hook が転写ログの印から実行を特定 | ✅ (`report(done)` が先に来ていれば二重に出さない) |

**待ちの実測 (5 分 19 秒 待たせたとき):**

```txt
03:11:37  ask_human  → 03:12:53  pending   (76 秒)
03:12:54  ask_wait   → 03:14:09  pending   (75 秒)
03:14:10  ask_wait   → 03:15:18  ERROR 502 Bad gateway (origin_bad_gateway)
03:15:19  ask_wait   → 03:16:34  pending   (75 秒)
03:16:36  ask_wait   → 03:16:59  answered "A案"
```

懸念していた «2 分を超えたツール呼び出しがバックグラウンドへ回る» には**当たらなかった**。
代わりに **75 秒はエッジの限界に近すぎる**ことが分かった (4 回目で 502)。エッジが切っているのは
«最初の 1 バイトが返らない» ためだったので、**SSE で即座にストリームを開いてから握る**形に
変えてある。それが上の «待ちのコスト» の 15 分 01 秒。この記録は、そこへ至る前の姿。

## 開発

```bash
pnpm test              # vitest (D1 は毎回まっさら)
pnpm run check-types
pnpm run check         # biome
pnpm run dev           # wrangler dev
```

設計・実装のルールは [CLAUDE.md](./CLAUDE.md)。

## この先やること（MVP に入れていない）

- **複数リポジトリ・スケジュール実行・GitHub イベント連携** — routine 側のトリガを足すだけで届く
- **自己ホスト環境** — runner を Cloudflare Container で動かすと、サブスク課金のまま実行を自分の Cloudflare に引き込める。
  Team/Enterprise の public beta で、Owner が `claude.ai/admin-settings/cloud-environments` で有効化する必要がある
