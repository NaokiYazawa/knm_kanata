# CLAUDE.md — knm_kanata の設計・実装ルール

Discord から **リモートの Claude Code (Claude Code on the web)** を回すための個人用ブリッジ。
Cloudflare Workers + D1 だけで動く。

## 1. この作りが «なぜこの形か»

Claude Code on the web には **走っているセッションへ外から発言を差し込む公式 HTTP API が無い**。
だから «こちらから話しかける» のは諦め、**セッション側から聞きに来させる**。
Worker 自身が MCP サーバー (`/mcp`) になり、対象リポジトリの `.mcp.json` から繋がれる。

```txt
/claude ──▶ Worker ──POST routines/{trig}/fire──▶ Anthropic-managed VM
                ▲                                      │
                └──── ask_human / report (MCP) ◀───────┘
```

`claude -p` を自前で回さないのは課金の都合。2026-06-15 以降 `claude -p` と Agent SDK は
**サブスク枠から外れ**、月 $20〜200 の Agent SDK クレジット (API 定価) になった。
cloud session は **サブスク席の枠のまま** なので、こちらを使う。この前提が崩れたら設計ごと見直す。

## 2. 層の分け方

- `domain/` … 純粋。I/O を持たない。Discord の制約・時刻・識別子・設定の検証はここ
- `db/repo.ts` … **SQL はここだけが持つ**。返すのは行 dict ではなく値オブジェクト
- `discord/` `mcp/` `hooks/` `anthropic/` … アダプタ。ドメインを薄く包む
- `index.ts` … 入口とゲートだけ。**各ハンドラの中で認証をやり直さない**

## 3. 必ず守ること

- **Discord の interaction は 3 秒以内に一次応答**。越えるものは «保留 (type 5)» を返して
  `waitUntil` に逃がす (`/claude` は routine 起動もスレッド作成も 3 秒に収まらない)
- **秘密を保存もログ出力もしない**。routine の fire トークンは Worker の secret
  (`PROJECTS_JSON`) だけに置き、D1 に入れない。エラーメッセージにも値を載せない
- **公開 URL のゲートは fail-closed**。Discord は Ed25519 署名、MCP と hook は Bearer
- **best-effort で握るなら why を書く**。無言の `catch {}` は書かない
- **人が読む文言は日本語**。コメント/docstring も日本語で、why を書く
- **保存は UTC / 見せるのは JST**。時刻は `domain/time.ts` だけが持つ。
  `"Asia/Tokyo"` や `+9` を他へ書かない
- **時間で待つテストを書かない**。待ちの長さは `ASK_WAIT_BUDGET_MS` で縮められる

## 4. 対で維持するもの (片方だけ直すと黙って壊れる)

| | 相手 |
| --- | --- |
| `domain/ids.ts` の `KANATA-<16hex>` | `repo-template/.claude/hooks/kanata-hook.sh` の grep |
| `index.ts` の `/hooks/*` のパス | 同じ hook スクリプトが叩く URL |
| `repo-template/.claude/settings.json` の hook 名 | スクリプト内の `hook_event_name` の分岐 |
| `domain/prompt.ts` の `ROUTINE_PROMPT` | claude.ai の routine に貼ってある本文 |
| `wrangler.jsonc` の `CONTEXT_WINDOW_TOKENS` | routine の `model` (1M のモデルなら 1000000) |
| `mcp/server.ts` の «落ちたら呼び直す» 契約 | `ROUTINE_PROMPT` とツール説明が言う復帰手順 |
| `domain/prompt.ts` の `buildFireText` | 同上 (payload の 1 行目を session_key として読む前提) |
| `mcp/server.ts` のツール名 | `ROUTINE_PROMPT` が名指ししている `mcp__kanata__*` |
| `domain/gateway.ts` の `GATEWAY_INTENTS` | Developer Portal の Privileged Gateway Intents |
| `wrangler.jsonc` の `durable_objects` / `migrations` | `index.ts` の `export { DiscordGatewayDO }` |

## 5. 待ちにトークンを使わせない (握り続ける)

`ask_human` は人が答えるまで Claude の turn を止める。**素朴に «まだです» を返して呼び直させると、
1 往復ごとに全文脈を積んだリクエストが飛ぶ** (45 秒周期なら 1 時間の放置で約 80 turn)。待っている
だけで果を食うのは実装の都合であって、仕様の必然ではない (放置しているだけのセッションは
リクエストを出さないので 0 円)。

だから **1 回のツール呼び出しを SSE で握り続ける**。握っている間 API リクエストは 1 本も飛ばず、
待ち時間のトークン消費は 0 になる。外した壁は 4 つ:

| 壁 | 実際の仕様 | 外し方 |
| --- | --- | --- |
| エッジが 75 秒で 502 | 切っているのは «最初の 1 バイトが返らない» ため | SSE で即座にストリームを開く |
| MCP の idle timeout | 応答も progress 通知も無い窓が続くと abort | ping と progress 通知を定期送信 |
| **2 分で背後へ回る** | «task ID を返して Claude は先へ進む» = 待ちが壊れる | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` |
| ツールの wall-clock | per-server `timeout` (未設定なら約 28 時間) | `.mcp.json` の `timeout` |

**3 つ目だけコードの外 (cloud environment の環境変数) にある。** 欠けたときの症状は
«質問を出した直後に Claude が勝手に先へ進む» で、握りの実装は正しいまま壊れる。

ping の間隔がエッジの限界より内側にあることは `server.test.ts` の guard が守る。

### 5.1 それでも握りは落ちる。落ちても失わせない

壁を全部外しても **transport は落ちる**。実測: 15 分 01 秒・6 分 22 秒は握れたのに、別の回は
5 分 00 秒で切れた (**時間では説明が付かない = こちらでは防げない**)。

落ちたとき Claude に届くのは `transport dropped mid-call; response for tool "ask_human" was
lost` という **`ask_id` を含まない**エラーなので、`ask_wait` では拾い直せない。Claude にできるのは
`ask_human` を呼び直すことだけ。

だから **`ask_human` は «問いを立てる» のではなく «返せていない問いがあれば拾い直す»**:

| そのとき | 返すもの |
| --- | --- |
| 返せていない問いに **答えが入っている** | その答え (質問は出し直さない) |
| 返せていない問いが **まだ未回答** | 同じ問いを握り直す (Discord に 2 通目を出さない) |
| 返せていない問いが無い | ふつうに新しい問いを立てる |

**`asks.delivered_at` は «Claude へ書き出せた» 時点で立てる。** ここを立て忘れると同じ答えを
何度も返し続け、立てるのが早すぎると答えが宙に浮く。拾うのは常に **いちばん新しい** 未配達の
問い — 古い方を拾うと、会話が先へ進んだ後に昔の答えが蘇る。

これが無かったとき何が起きたか (2026-08-29 14:38): 握りが 5 分で落ち、その 37 秒前に入っていた
依頼者の質問が宙に浮き、Claude は同じ回答を «(直前の接続が切れたため再送します)» と付けて
**Discord に 2 通目として出した**。依頼者の質問は誰にも届かないまま消えた。

## 5.5 スレッドは 1 本の会話

**スレッドに素で書いた文がそのまま Claude への発言になる。** `/claude` は kanata が知らない
場所で **起動**するためだけのコマンドで、知っているスレッドの中では素の文と**同じ口**へ入る
(`discord/inbound.ts` の `applyInbound`)。同じスレッドに同じ文を書いたのに、コマンドか素の文かで
結果が変わってはいけない。

判定は `domain/inbound.ts` が 1 つだけ持つ。走っているセッションへ外から発言を差し込む手段は
無いので、扱いは 4 通りしかない:

| 状況 | 扱い |
| --- | --- |
| 待っている質問がある | **回答**として渡す (握りが即座に解ける) |
| 作業中 | **溜める** (`inbox`)。次に `ask_human` が呼ばれたとき渡す |
| 終わっている / 落ちている | 同じスレッドで **新しく起こす** (溜めていた分も一緒に渡す) |
| kanata の会話ではない | **何もしない**。起動は `/claude` だけ |

**«生きている» の判定を省かない。** 落ちたセッションの未回答の質問が残っていると、以後その
スレッドの発言を永久に飲み込む «穴» になる (答えを受け取る相手がもう居ない)。握りが 15 秒ごとに
`touchSession` で印を更新し、それが新しいものだけを生きているとみなす。

**印の窓は 2 つある**。握っている間は 15 秒ごとに更新されるが、作業中は誰も触らないので
数時間開く。同じ窓で見ると «20 分黙って実装している最中の 1 行» で 2 つ目のセッションが立つ。
外し方の代償が非対称 (溜めすぎ = 届かない・取り返せる / 起こしすぎ = 2 本立つ・取り返せない)
なので、迷ったら **溜める側**へ倒す。

だから routine のプロンプトは «作業が終わったら done で終わる» ではなく **«ask_human で
「次は？」と聞いて待つ»** になっている。終わるのは «おわり» と言われたときだけ。
ここが崩れるとスレッドが 1 回で死ぬ。

### 5.5.1 素の文はどこから来るか

**Discord には素の文 (MESSAGE_CREATE) を HTTP で受け取る手段が無い。** webhook で飛んでくるのは
Social SDK 由来の一部イベントだけで、チャンネルの発言は今も常時接続の WebSocket でしか来ない。
だから Durable Object が 1 つ、Gateway への接続を持ち続ける (`gateway/gateway.do.ts`)。

守ること:

- **DO は 1 つだけ** (`idFromName("main")`)。outbound WebSocket は hibernation 非対応で、
  繋いでいる間ずっと duration 課金になる (月 約 324,000 GB-s = 含有枠 400,000 の内側)。
  2 つ目の常駐 DO を足すと枠を超える
- **`setInterval` を使わない。** outbound WebSocket が DO を生かすのは **1 接続あたり最長 15 分**
  なので、必ずどこかで消える。タイマは alarm、その alarm ごと消えた場合の保険が 5 分 cron の
  `POST /ensure` (DO は自分では起動できない)
- **状態遷移は `domain/gateway.ts` の `step` だけが持つ。** ゾンビ接続・op 9 の `d:false`・
  close 4014 は本番でしか起きないので、入力を手で作れる純粋関数に切ってある
- **`fetch` に `wss://` を渡さない。** `Fetch API cannot load: wss://…` で即座に落ち、ソケットが
  開かないので «原因不明で繋がらない» にしか見えない。`gatewayConnectUrl` が `https://` へ直す
- **直らない失敗 (close 4004 / 4014) は `fatal` にして張り直さない。** 張り続けると identify の
  レート制限を静かに使い切る。復帰は人が `POST /gateway/reset`

## 5.6 Claude の発言は地の文で出す

`ask_human` の問いかけと `report(progress)` は **Claude 本人が喋っている**ので、枠も見出しも
付けない (`content` に素で出す)。「❓ 確認したいことがあります」のような宣言は要らない —
押せる口があることはボタンが示す。枠を付けてよいのは **状態が変わったとき**だけ
(起動 / `blocked` / 終了の印)。

同じ理由で **同じ内容を `report` と `ask_human` の 2 回に分けさせない**。routine のプロンプトが
«やったこと» と «次は？» を 1 回の `ask_human` にまとめるよう指示している。

## 5.7 コンテキストの残量を見せる

**Claude Code は «いまどれだけコンテキストを使ったか» を外へ出さない。** どの hook の入力にも
トークン数は入っておらず、ステータスラインは対話 UI 専用でクラウドセッションでは動かない。
唯一の出口が **転写ログ (`transcript_path`) の `message.usage`** なので、hook が読んで
`/hooks/context` へ送る。

- 分子は公式のステータスラインと同じ式にそろえる:
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (**output は含めない**)。
  ここを外すと、キャッシュを多用したセッションで «まだ 5% しか使っていない» ように見える
- **分母は転写ログから読めない**ので設定で持つ (`CONTEXT_WINDOW_TOKENS`、既定 200,000)。
  ズレても **生のトークン数を併記する**ので、読み手が真値を見失うことはない
- 出す場所は **Claude の発言の末尾**だけ (`-#` の subtext)。次に何を言うか決めるまさにその場にあるので、見に行く必要がない。
  スレッド名は Discord の «2 回 / 10 分» の制限で使えない
- 転写ログは非同期に書かれるので **1 つ古いことがある** (公式ドキュメントに明記)。
  桁を見るには十分、という前提で読む

### 5.7.1 `Stop` は «終了» ではない

`Stop` は「Claude が応答を終えたとき」= **1 ターンごと**に鳴る。セッションの終了は `SessionEnd`。

ここを間違えて `Stop` で `status = "done"` を立てていたため、会話の途中で «🏁 セッションが
終了しました» が出ていた (同じセッションが 8 回鳴らした記録がある)。**`§5.5` の判定と噛み合うと
もっと悪い** — `done` が立ったスレッドへ次に書くと «起こし直し» になり、生きているセッションの
隣に 2 本目が立つ。

コンテキスト量の通報 (`Stop` / `PreToolUse`) は **`updated_at` を触らない**。あれは «握りが
生きている» の印で、Stop が鳴いた時点でもう握っていない。混ぜると死んだ質問へ回答を書き込む。

## 5.8 スキルは «リポジトリに置く» か «claude.ai で有効にする»

クラウドセッションは **手元のマシンの `~/.claude/skills/` を読まない**。読むのは 2 つだけ:

- クローンしたリポジトリの **`.claude/skills/`** (clone の一部として届く)
- **claude.ai のアカウントで有効にしたスキル** (Anthropic 経由で届く。許可ドメイン不要)

複数リポジトリで共通に使いたいものは **claude.ai 側**に置く。リポジトリの
`.claude/settings.json` でプラグインを宣言する道もあるが、**セッション開始時にマーケット
プレイスへ取りに行く**ので、そのホストを cloud environment の Allowed domains に足す必要がある
(`§6` の表と同じ落とし穴)。

**同名の解決順に注意。** リポジトリのスキルは claude.ai 同期スキルを上書きする。一方
`~/.claude/skills/` はローカルでは project より強いのにクラウドでは読まれないので、
**手元では動くのにクラウドで «スキルが無い» と言われる**組み合わせが作れてしまう。

## 5.9 プロジェクトとチャンネルとリポジトリ

プロジェクトを 1 つ増やす手順は **[docs/new-project.md](./docs/new-project.md)**。

**既定は «1 チャンネル = 1 プロジェクト = 1 リポジトリ (モノレポ)»。** この形なら作業
ディレクトリがリポジトリ直下のままなので、commit した `.mcp.json` と `.claude/settings.json`
がそのまま効き、環境側に置く設定は要らない (`cloud-setup.sh` は貼らない)。

- **`/claude` の行き先は 3 段で決める**: `project` の明示 → **チャンネルとの結び付け** →
  プロジェクトが 1 つだけならそれ。**«唯一だから» で勝手に選ばない場所を残す** —
  雑談チャンネルの `/claude` が本番リポジトリに飛ぶ事故を作らない。スレッドで叩かれたら
  `channel.id` はスレッドなので `parent_id` でも照合する
- **`PROJECTS_JSON` の `repos` は表示用**。正本は routine の `sources`。
  **セッションが触れる範囲は `sources` が厳密な境界**で、実測で確かめてある:
  非公開リポジトリは `git` で clone できず (credential helper が無い)、`mcp__github__*` も
  sources にスコープされて拒否される。**ここに書き足しても触れるようにはならない**
- **リポジトリを 2 本以上入れると作業ディレクトリが `/home/user` へ上がる**。
  プロジェクトスコープの `.mcp.json` と `.claude/settings.json` は作業ディレクトリから
  読まれるので、commit してあっても届かず **ask_human も report も消える** (実測)。
  塞ぐのは `cloud-setup.sh` を cloud environment の Setup script に貼ること (`§6` の表)。
  スキルは無事なので、壊れるのは «プロジェクトルートから読む設定» だけ

**テストのプロジェクトは 2 つ以上にしておく。** 1 つだと «唯一だから選ばれた» に守られて、
チャンネルとの結び付けが壊れていても気付けない (`vitest.config.ts` に理由を書いてある)。

## 6. routine 側の設定は «コードの外にある前提»

Worker のコードだけ正しくても動かない。routine と cloud environment に次が要る:

| 置き場所 | 何を |
| --- | --- |
| cloud environment の Allowed domains | Worker のホスト名 (**スキーム無し**) |
| cloud environment の環境変数 | `KANATA_URL` / `KANATA_TOKEN` |
| routine が向いている環境 | **全プロジェクトで同じものを使う** (環境変数と許可ドメインは環境に付く) |
| routine の `allowed_tools` | `mcp__kanata` と 3 つのツール名 (無いと承認待ちで固まる) |
| Discord Developer Portal | **MESSAGE CONTENT INTENT** (無いと Gateway が close 4014 で切られる) |
| 手元の `projects.json` | 本番の secret `PROJECTS_JSON` (**読み出せないので手元が正本**。`projects:push` で送る) |
| routine の API トークン | `projects.json` の `fireToken` (**発行し直したら送り直す**。`projects:push` が通るか確かめる) |
| cloud environment の Setup script | `cloud-setup.sh` (**リポジトリが 2 本以上の routine のときだけ**。モノレポなら貼らない) |

どれが欠けても症状は «ask_human が呼ばれない» で同じに見える。切り分けは
**存在しない `session_key` で `ask_human` を 1 回だけ呼ばせる** のが速い
(Discord に触れずに outbound の全経路を確かめられる)。

## 7. 変更時のチェックリスト

1. 既存の共有先 (`domain/*` `db/repo.ts` `discord/components.ts`) に振り分けられないか
2. 秘密・ゲート・3 秒応答の抜けはないか
3. best-effort の握りに why はあるか
4. テストを足したか。時間待ちに頼っていないか
5. `pnpm run check-types && pnpm run check && pnpm test` が緑か
