# 新しいプロジェクトを始める

kanata 本体 (Worker・D1・Discord アプリ・cloud environment) が既に動いている前提で、
**プロジェクトを 1 つ増やす手順**。所要 15 分ほど。

初回のセットアップは [README](../README.md) を見る。

```txt
Discord チャンネル  ──  プロジェクト  ──  routine  ──  GitHub リポジトリ
   #alpha                 alpha          trig_…        NaokiYazawa/alpha
```

紐付けを持つのは **`PROJECTS_JSON` (Worker の secret) だけ**。管理画面は無い。

---

## 0. 先に決める — モノレポか、複数リポジトリか

**選んだリポジトリ (routine の `sources`) が、そのセッションが触れる範囲の境界**になる。
非公開リポジトリは後から clone できず (認証はサンドボックスの外の proxy にあり sources に
スコープされる)、`mcp__github__*` も sources 外は拒否される。**後から会話の中で足せない。**

| | モノレポ (1 本) | 複数リポジトリ |
| --- | --- | --- |
| 作業ディレクトリ | リポジトリ直下 | **`/home/user`** |
| `.mcp.json` (kanata の配線) | 効く | 効かない → `cloud-setup.sh` が要る |
| `.claude/settings.json` (フック) | 効く | 同上 |
| **`CLAUDE.md`** | **起動時に読まれる** | **そのリポジトリのファイルを読むまで読まれない** |
| `.claude/skills/` | 効く | 効く |
| リポジトリを跨いだ読み書き | できない | できる |

**迷ったらモノレポ。** 複数にするのは «api と web を 1 つの会話で直す» が実際に要るときだけ。
複数を選ぶなら [§4](#4-cloud-environment-複数リポジトリのときだけ) を必ずやる。

---

## 1. GitHub — リポジトリに置くもの

```bash
cp -r /path/to/knm_kanata/repo-template/. /path/to/alpha/
cd /path/to/alpha && git add .mcp.json .claude && git commit -m "kanata を繋ぐ"
git push
```

| ファイル | 役目 |
| --- | --- |
| `.mcp.json` | Worker を MCP サーバーとして繋ぐ。**project スコープは確認プロンプト無しで読まれる** |
| `.claude/settings.json` | フックの登録 (`PreToolUse` / `Stop` / `SessionEnd`) |
| `.claude/hooks/kanata-hook.sh` | コンテキスト残量の通報と、完了通知の保険 |

**リポジトリは public でも private でもよい** (clone は Claude の GitHub 連携が行う)。
`.claude/skills/<名前>/SKILL.md` を置けばクラウドセッションでそのまま使える。

---

## 2. Discord — チャンネルを 1 つ作る

1. サーバーにチャンネルを作る (例: `#alpha`)
2. **チャンネル ID をコピー**
   設定 → 詳細設定 → **開発者モード** を on → チャンネルを右クリック → **ID をコピー**
3. bot がそのチャンネルを見えることを確かめる (見えなければチャンネルの権限に bot を足す)

必要な bot 権限は初回の招待で付いている:
`View Channels` / `Send Messages` / `Create Public Threads` / `Send Messages in Threads` /
`Add Reactions`。

**チャンネルは 1 プロジェクトに 1 つ。** 2 つのプロジェクトに同じチャンネルを結び付けると、
kanata は行き先を決められないので設定ごと断る。

---

## 3. Anthropic — routine を 1 本作る

[claude.ai/code/routines](https://claude.ai/code/routines) → **New routine**。

1. **Name** — `kanata: alpha` のように
2. **Instructions** — `pnpm exec node scripts/print-routine-prompt.ts` の出力をそのまま貼る
3. **Select a repository** — 対象リポジトリを選ぶ。**ここが §0 で決めた境界**。
   選ぶまで API トリガが押せない ("Select a repository first")
4. **モデル** — `claude-opus-5[1m]` (Opus 5 の 1M コンテキスト)。Team プランならサブスクに
   含まれる。**分母 `CONTEXT_WINDOW_TOKENS` と対**なので、200k のモデルにするならそちらも戻す
5. **環境** — **既に使っている環境をそのまま選ぶ**。`KANATA_URL` / `KANATA_TOKEN` と
   許可ドメインは**環境に付く**ので、プロジェクトごとに入れ直す必要はない。
   **新しい「Default」を作らせない** — 空の環境を向くと `KANATA_URL` が無く、
   `${KANATA_URL}/mcp` が不正な URL になって `mcp__kanata__*` が丸ごと消える
6. **Select a trigger → API** → 保存 → もう一度開いて **Generate token**。
   **トークンは一度しか表示されない**。URL と一緒に控える
7. **⚠️ Connectors から要らないものを全部外す**

> *"Claude can use all tools from these connectors — including writes — without asking for
> permission during runs."*

routine は**承認する人がいない状態で自律実行される**ので、付けたままだと事故の範囲がそこまで
広がる。作成時に既存のコネクタが全部自動で付くので、**毎回外す**。

### 作った後に 1 つ確かめる

`allowed_tools` に `mcp__kanata` が入っていないと、**承認待ちで無言で止まる**
(ログに `permission prompt mcp__kanata__ask_human` が出たまま進まない)。

---

## 4. cloud environment (複数リポジトリのときだけ)

環境の **Setup script** に [`cloud-setup.sh`](../cloud-setup.sh) を貼る。
中身はどのプロジェクトでも同じなので、**環境に 1 回貼れば以後は routine にリポジトリを並べるだけ**。

**モノレポなら貼らない。**
貼ったままだと `/home/user/.claude/settings.json` がユーザースコープの設定としても読まれ、同じフックが 2 回走りうる (実害は同じ値を 2 回書くだけだが、無駄)。

環境変数と許可ドメインは全プロジェクト共通で、初回に入れたものがそのまま効く
(`KANATA_URL` / `KANATA_TOKEN` / `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` / Worker のホスト名)。

---

## 5. Worker — `projects.json` に 1 要素足す

**手元の `projects.json` が正本。** `.gitignore` 済みで、中に routine の fire トークンが入る。
無ければ `cp projects.example.json projects.json`。

```json
[
  {
    "name": "alpha",
    "repoUrl": "https://github.com/NaokiYazawa/alpha",
    "fireUrl": "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire",
    "fireToken": "sk-ant-oat01-…",
    "channelId": "1543…"
  }
]
```

| 鍵 | 要否 | 何を書くか |
| --- | --- | --- |
| `name` | 必須 | `/claude` の project 選択肢に出る名前。重複不可 |
| `repoUrl` | 必須 | GitHub の URL。起動メッセージにリポジトリ名として出す |
| `fireUrl` | 必須 | routine の API トリガの URL |
| `fireToken` | 必須 | 同トークン (`sk-ant-oat01-…`)。**一度しか表示されない** |
| `channelId` | 任意 | このチャンネルの `/claude` が自動でこのプロジェクトになる。重複不可 |
| `repos` | 任意 | 触れるリポジトリの一覧 (**表示用**)。モノレポなら書かない |

```bash
pnpm run projects:push -- --dry-run          # 送る内容とトークンの通りを先に見る
pnpm run projects:push -- --profile linto    # 検証して secret へ送る
pnpm run commands:register                   # /claude の project 選択肢を更新 (任意)
```

**`projects:push` は送る前にトークンが本当に通るか叩いて確かめる** (セッションは作らないので
実行回数を消費しない)。通らないものがあれば送らずに止まる。`sk-ant-x` のような置き換え忘れは
形の検査をすり抜けるので、**実際に叩くしかない** — すり抜けて本番へ行き `/claude` が 401 で
落ちたことがある。

**secret は書き込み専用で読み出せない** (`wrangler secret list` は名前しか返さない)。そして
`wrangler secret put` は**値を丸ごと置き換える**ので、`projects.json` に既存のプロジェクトが
残っていないと消える。消えて痛いのは `fireToken` で、失うと web UI で発行し直す
(= 前のを失効させる) しかない。**足すときは配列に要素を追加する。**

`projects:push` は `projects.json` **だけ**を読み、本体と同じ検証を通してから送る。壊れた値を
送ると `/claude` が丸ごと止まるので、その前に落とす。

## 6. 動かして確かめる

`#alpha` で:

```txt
/claude task:「ping」
```

| 見えるべきもの | 見えなければ |
| --- | --- |
| 🚀 起動 (プロジェクト名とリポジトリが出る) | `PROJECTS_JSON` の `channelId` を確認 |
| ▶️ 実行中 (セッションのリンク) | routine の fireUrl / fireToken |
| Claude の返事 + 残量バー | 下の表へ |

そのまま**スレッドに素で書く**と会話が続く。`/claude` はもう要らない。

---

## 詰まったときの見どころ

| 症状 | 原因 |
| --- | --- |
| 「このチャンネルに結び付いたプロジェクトがありません」 | `channelId` が違う / 入れ忘れ |
| 起動はするが Claude が何も言わない | `allowed_tools` に `mcp__kanata` が無く承認待ち |
| 「KANATA_URL/KANATA_TOKEN が環境変数に無い」と言って終わる | routine が**別の環境**を向いている。既存の環境に付け替える |
| `AUTH_HEADER_REJECTED (HTTP 403)` | **トークンではなく許可ドメイン**。`request blocked: no rule or allowlist` の方を読む |
| 質問を出した直後に Claude が先へ進む | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` が無い |
| 素の文を書いても反応しない | Gateway。`GET /gateway/status` の `fatalReason` を読む |
| 複数リポジトリで `ask_human` が使えない | `cloud-setup.sh` を貼っていない |
| 残量バーが出ない | フック。リポジトリに `.claude/` を commit したか |
