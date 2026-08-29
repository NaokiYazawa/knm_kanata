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
| `domain/ids.ts` の `KANATA-<16hex>` | `repo-template/.claude/hooks/kanata-stop.sh` の grep |
| `domain/prompt.ts` の `ROUTINE_PROMPT` | claude.ai の routine に貼ってある本文 |
| `domain/prompt.ts` の `buildFireText` | 同上 (payload の 1 行目を session_key として読む前提) |
| `mcp/server.ts` のツール名 | `ROUTINE_PROMPT` が名指ししている `mcp__kanata__*` |

## 5. 待ちにトークンを使わせない (握り続ける)

`ask_human` は人が答えるまで Claude の turn を止める。**素朴に «まだです» を返して呼び直させると、
1 往復ごとに全文脈を積んだリクエストが飛ぶ** (45 秒周期なら 1 時間の放置で約 80 turn)。待っている
だけで果を食うのは実装の都合であって、仕様の必然ではない (放置しているだけのセッションは
リクエストを出さないので 0 円)。

だから **1 回のツール呼び出しを SSE で握り続ける**。握っている間 API リクエストは 1 本も飛ばず、
待ち時間のトークン消費は 0 になる。外した壁は 4 つ:

| 壁 | 実際の仕様 | 外し方 |
|---|---|---|
| エッジが 75 秒で 502 | 切っているのは «最初の 1 バイトが返らない» ため | SSE で即座にストリームを開く |
| MCP の idle timeout | 応答も progress 通知も無い窓が続くと abort | ping と progress 通知を定期送信 |
| **2 分で背後へ回る** | «task ID を返して Claude は先へ進む» = 待ちが壊れる | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` |
| ツールの wall-clock | per-server `timeout` (未設定なら約 28 時間) | `.mcp.json` の `timeout` |

**3 つ目だけコードの外 (cloud environment の環境変数) にある。** 欠けたときの症状は
«質問を出した直後に Claude が勝手に先へ進む» で、握りの実装は正しいまま壊れる。

ping の間隔がエッジの限界より内側にあることは `server.test.ts` の guard が守る。握りが切れた
ときのために `ask_wait` は残すが、**保険であって主経路ではない**。

## 5.5 スレッドは 1 本の会話

`/claude` は 1 つのコマンドで 2 つの意味を持つ:

- そのスレッドに **生きているセッションが待っている質問があれば** → その **回答**として渡す
- 無ければ → 新しいセッションの **起動**

**«生きている» の判定を省かない。** 落ちたセッションの未回答の質問が残っていると、以後その
スレッドの `/claude` を永久に飲み込む «穴» になる (答えを受け取る相手がもう居ない)。握りが
15 秒ごとに `touchSession` で印を更新し、それが新しいものだけを生きているとみなす。

だから routine のプロンプトは «作業が終わったら done で終わる» ではなく **«report(progress) して
から ask_human で「次は？」と聞いて待つ»** になっている。終わるのは «おわり» と言われたときだけ。
ここが崩れるとスレッドが 1 回で死ぬ。
## 6. routine 側の設定は «コードの外にある前提»

Worker のコードだけ正しくても動かない。routine と cloud environment に次が要る:

| 置き場所 | 何を |
|---|---|
| cloud environment の Allowed domains | Worker のホスト名 (**スキーム無し**) |
| cloud environment の環境変数 | `KANATA_URL` / `KANATA_TOKEN` |
| routine の `allowed_tools` | `mcp__kanata` と 3 つのツール名 (無いと承認待ちで固まる) |

どれが欠けても症状は «ask_human が呼ばれない» で同じに見える。切り分けは
**存在しない `session_key` で `ask_human` を 1 回だけ呼ばせる** のが速い
(Discord に触れずに outbound の全経路を確かめられる)。

## 7. 変更時のチェックリスト

1. 既存の共有先 (`domain/*` `db/repo.ts` `discord/components.ts`) に振り分けられないか
2. 秘密・ゲート・3 秒応答の抜けはないか
3. best-effort の握りに why はあるか
4. テストを足したか。時間待ちに頼っていないか
5. `pnpm run check-types && pnpm run check && pnpm test` が緑か
