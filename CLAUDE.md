# CLAUDE.md — knm_kanata の設計・実装ルール

Discord から **リモートの Claude Code (Claude Code on the web)** を回すための個人用ブリッジ。
Cloudflare Workers + D1 だけで動く。

## 1. この作りが «なぜこの形か»

Claude Code on the web には **走っているセッションへ外から発言を差し込む公式 HTTP API が無い**。
だから «こちらから話しかける» のは諦め、**セッション側から聞きに来させる**。
Worker 自身が MCP サーバー (`/mcp`) になり、対象リポジトリの `.mcp.json` から繋がれる。

```
/claude ──▶ Worker ──POST routines/{trig}/fire──▶ Anthropic 管理 VM
                ▲                                      │
                └──── ask_human / report (MCP) ◀────────┘
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
|---|---|
| `domain/ids.ts` の `KANATA-<16hex>` | `repo-template/.claude/hooks/kanata-stop.sh` の grep |
| `domain/prompt.ts` の `ROUTINE_PROMPT` | claude.ai の routine に貼ってある本文 |
| `domain/prompt.ts` の `buildFireText` | 同上 (payload の 1 行目を session_key として読む前提) |
| `mcp/server.ts` のツール名 | `ROUTINE_PROMPT` が名指ししている `mcp__kanata__*` |

## 5. 待ちの長さは «75 秒» が上限

`ask_human` は人が答えるまで Claude の turn を止める。ただし 1 回の待ちは 75 秒で切り上げ、
`status: "pending"` を返して `ask_wait` を呼び直させる。理由は 2 つ:

- Cloudflare のエッジは応答が始まらないまま 100 秒ほどで切る
- Claude Code は **2 分を超えたツール呼び出しをバックグラウンドタスクへ回す** (v2.1.212+)

伸ばしたくなったら、まず «待ち続ける責務は Claude 側のループにある» を思い出すこと。

## 6. 変更時のチェックリスト

1. 既存の共有先 (`domain/*` `db/repo.ts` `discord/components.ts`) に振り分けられないか
2. 秘密・ゲート・3 秒応答の抜けはないか
3. best-effort の握りに why はあるか
4. テストを足したか。時間待ちに頼っていないか
5. `pnpm run check-types && pnpm run check && pnpm test` が緑か
