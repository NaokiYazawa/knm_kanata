import { Repo, type Session } from "../db/repo";
import { askAnsweredMessage, askMessage, reportMessage } from "../discord/components";
import { markDelivered } from "../discord/inbound";
import { DiscordRest } from "../discord/rest";
import { isAskProblem, validateAsk } from "../domain/ask";
import { contextLine, contextWindowTokens } from "../domain/context";
import { newAskId } from "../domain/ids";
import { SERVER_INSTRUCTIONS } from "../domain/prompt";
import type { Env } from "../env";

/**
 * Worker 自身が MCP サーバーになる。cloud session はここへ繋いで **人に聞きに来る**。
 *
 * なぜこの形か: Claude Code on the web には «走っているセッションへ外から発言を差し込む»
 * 公式 HTTP API が無い。だから «こちらから話しかける» のを諦め、**セッション側から聞かせる**。
 * ツール呼び出しは Claude の turn を止めるので、人が答えるまで待たせられる。
 *
 * ## 待ちにトークンを使わせない
 *
 * 素朴に «まだです» を返して呼び直させると、1 往復ごとに tool_result が返り、**そのたびに
 * 全文脈を積んだリクエストが飛ぶ**。45 秒周期なら 1 時間の放置で約 80 turn。待っているだけで
 * 果を食うのは実装の都合であって、仕様の必然ではない。
 *
 * そこで **1 回のツール呼び出しを握り続ける**。握っている間 API リクエストは 1 本も飛ばないので、
 * 待ち時間のトークン消費は 0 になる。握るために外した壁は 5 つ:
 *
 * | 壁 | 実際の仕様 | 外し方 |
 * |---|---|---|
 * | エッジが 75 秒で 502 | 切っているのは «最初の 1 バイトが返らない» ため | **SSE で即座にストリームを開く** |
 * | MCP の idle timeout | 応答も progress 通知も無い窓が続くと abort | ping と progress 通知を定期送信 |
 * | 2 分で背後へ回る | «task ID を返して Claude は先へ進む» = 待ちが壊れる | 環境変数 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` |
 * | **無音 5 分で abort** | v2.1.187 以降のクライアント側の打ち切り | 環境変数 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` + `SILENT_HOLD_MS` |
 * | ツールの wall-clock | per-server `timeout` (未設定なら約 28 時間) | `.mcp.json` の `timeout` |
 *
 * 3 つ目と 4 つ目はコードの外 (cloud environment の環境変数) にあるので、README に対で書いてある。
 * 縛るのは壁時計ではなく **CPU 時間** (Workers Paid で既定 30 秒) なので、`ASK_HOLD_MS` を
 * 伸ばすときは `wrangler.jsonc` の `limits.cpu_ms` も上げる。
 *
 * ## 握りは落ちる。落ちても失わせない
 *
 * 壁を全部外しても **transport は落ちる** (実測: 15 分・6 分 22 秒は握れたのに、別の回は
 * 5 分 00 秒で切れた — こちらは 4 つ目の壁そのもので、いまは塞いである)。落ちたとき Claude に届くのは
 * `transport dropped mid-call; response for tool "ask_human" was lost` という
 * **ask_id を含まない**エラーなので、`ask_wait` では拾い直せない。Claude にできるのは
 * `ask_human` を呼び直すことだけ。
 *
 * だから **`ask_human` は «問いを立てる» のではなく «返せていない問いがあれば拾い直す»**。
 * これが無いと落ちるたびに Discord へ同じ質問が 2 通出て、切れている間に入った答えは
 * 誰にも渡らないまま消える (実際に 1 つ失った)。`ask_wait` は ask_id が手元にあるときの
 * 近道として残す。
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** 1 回の握りの長さ。ここを超えたら «まだです» を返して `ask_wait` に引き継ぐ。 */
export const DEFAULT_HOLD_MS = 15 * 60_000;
/** 回答が入ったかを見に行く間隔。D1 を引くだけなので CPU はほぼ使わない。 */
const DEFAULT_POLL_MS = 3_000;
/**
 * 沈黙を作らない間隔。**これがエッジの限界より十分内側であることが握りの前提**で、
 * `server.test.ts` の guard が伸ばす向きの変更を止める。
 */
const DEFAULT_PING_MS = 15_000;

/** 応答が始まらないまま握ると、これを超えたあたりで Cloudflare が 502 を返す (実測)。 */
export const OBSERVED_EDGE_CUTOFF_MS = 75_000;

/**
 * **クライアント側 (Claude Code) が握りを切る時間。**
 *
 * v2.1.187 以降、«応答も progress 通知も無い» まま 5 分経ったリモート MCP ツール呼び出しは
 * abort される (既定 5 分 / `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` で変えられるが、公式
 * ドキュメントには載っていない)。**«時間では説明が付かない» とされていた «5 分 00 秒ちょうどで
 * 落ちる» の正体がこれ。**
 *
 * SSE のコメント行 (`: ping`) は JSON-RPC メッセージではないので、**この時計は止まらない**。
 * 止められるのは progress 通知だけで、それは `progressToken` を渡されたときしか送れない (仕様)。
 */
export const CLIENT_IDLE_ABORT_MS = 5 * 60_000;

/**
 * `progressToken` が無く、**クライアントから見て完全な沈黙になるとき**の握り上限。
 *
 * ここで自分から `pending` を返して降りれば、Claude は `ask_wait` で拾い直せる。
 * 黙って abort されると `ask_id` を含まないエラーになり、拾い直せるのは `ask_human` の
 * «返せていない問い» 経路だけになる (それも往復が 1 つ増える)。
 * **`CLIENT_IDLE_ABORT_MS` より内側であることが前提**で、`server.test.ts` の guard が守る。
 */
export const SILENT_HOLD_MS = 4 * 60_000;

export const DEFAULTS = {
  holdMs: DEFAULT_HOLD_MS,
  pollMs: DEFAULT_POLL_MS,
  pingMs: DEFAULT_PING_MS,
} as const;

/** 実測しながら詰める値なので env で動かせる。テストは待たないために極端に短くする。 */
function holdConfig(env: Env): { holdMs: number; pollMs: number; pingMs: number } {
  const pick = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw ?? "");
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    holdMs: pick(env.ASK_HOLD_MS, DEFAULT_HOLD_MS),
    pollMs: pick(env.ASK_POLL_MS, DEFAULT_POLL_MS),
    pingMs: pick(env.ASK_PING_MS, DEFAULT_PING_MS),
  };
}

const SERVER_INFO = { name: "kanata", version: "0.2.0" };

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

/** `waitUntil` だけを要求する。Hono と workers-types で ExecutionContext の形が違うため。 */
export type Waitable = { waitUntil(promise: Promise<unknown>): void };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function result(id: JsonRpcId, value: unknown): Response {
  return json({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(id: JsonRpcId, text: string, isError = false): unknown {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } };
}

function textResult(id: JsonRpcId, text: string, isError = false): Response {
  return json(toolResult(id, text, isError));
}

const TOOLS = [
  {
    name: "ask_human",
    title: "依頼者に確認する",
    description:
      '判断が要ることを依頼者に確認し、答えが返るまで待つ。選択肢はボタンとして Discord に出る (選択肢に無いことは依頼者がスレッドへ直接書いて答える)。答えが返るまでこの呼び出しは戻らない。status:pending が返ったら同じ ask_id で ask_wait を呼び直すこと。接続エラーで落ちた (ask_id が手元に無い) ときは、同じ session_key でこれを呼び直せばよい — question は "(再送)" の 1 語でよく、直前の問いを握り直すか、切れている間に届いた答えを返す。質問が二重に出ることはない。',
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", description: "指示の 1 行目にある KANATA- で始まる値" },
        question: { type: "string", description: "確認したいこと。前提も含めて自己完結させる" },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "選ばせたい選択肢 (最大 20 個)。省略してよい — 依頼者はどちらの場合もスレッドへ直接書いて答えられる",
        },
      },
      required: ["session_key", "question"],
    },
  },
  {
    name: "ask_wait",
    title: "回答を待ち直す",
    description: "ask_human が status:pending を返したとき、同じ ask_id で回答を待ち直す。",
    inputSchema: {
      type: "object",
      properties: { ask_id: { type: "string" } },
      required: ["ask_id"],
    },
  },
  {
    name: "report",
    title: "進捗を伝える",
    description:
      "依頼者のスレッドへ進捗を出す。kind は progress / blocked / done。done を呼ぶとスレッドの会話は終わる。",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string" },
        kind: { type: "string", enum: ["progress", "blocked", "done"] },
        text: { type: "string" },
      },
      required: ["session_key", "kind", "text"],
    },
  },
];

export async function handleMcp(request: Request, env: Env, ctx?: Waitable): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "JSON として読めません");
  }

  const id = body.id ?? null;
  const method = body.method ?? "";

  // 通知 (id なし) は受け取ったことだけ返す。
  if ((body.id === undefined || body.id === null) && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      const requested = body.params?.protocolVersion;
      const version =
        typeof requested === "string" &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        // クライアントがシステムプロンプトへ差し込む。**握りが落ちたときの復帰手順を
        // サーバー自身が名乗る**ための口で、routine 側への貼り忘れで契約が壊れなくなる。
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, body.params ?? {}, env, ctx);
    default:
      return rpcError(id, -32601, `未対応のメソッド: ${method}`);
  }
}

/** progress 通知は «要求で渡されたトークン» にしか紐付けられない (仕様)。無ければ送らない。 */
function progressToken(params: Record<string, unknown>): string | number | null {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null) return null;
  const token = (meta as Record<string, unknown>).progressToken;
  return typeof token === "string" || typeof token === "number" ? token : null;
}

async function callTool(
  id: JsonRpcId,
  params: Record<string, unknown>,
  env: Env,
  ctx?: Waitable,
): Promise<Response> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const token = progressToken(params);

  switch (name) {
    case "ask_human":
      return askHuman(id, args, env, token, ctx);
    case "ask_wait":
      return askWait(id, args, env, token, ctx);
    case "report":
      return report(id, args, env);
    default:
      return textResult(id, `未対応のツール: ${name}`, true);
  }
}

function target(session: Session): string {
  return session.threadId ?? session.channelId;
}

type Liveness =
  | Readonly<{ alive: true }>
  | Readonly<{ alive: false; status: string; text: string }>;

/**
 * **このセッションは、まだ «答えを受け取る相手» として生きているか。**
 *
 * 生きていないのに待たせ続けると turn が漏れ続ける。同じスレッドで新しいセッションが
 * 起こされると (`domain/inbound.ts` の restart)、古い方の未回答の問いは誰にも答えられなく
 * なるが、古い方はそれを知る手段を持たない。`ask_wait` → 15 分握る → `pending` →
 * `ask_wait` … を **永久に**繰り返し、15 分ごとに全文脈を積んだリクエストが飛ぶ。
 * 「待ちにトークンを使わせない」を、いちばん静かに裏切る経路がここだった。
 */
async function checkAlive(repo: Repo, session: Session): Promise<Liveness> {
  if (session.status === "done" || session.status === "failed") {
    return {
      alive: false,
      status: "closed",
      text: "このセッションは終了しています。これ以上 kanata のツールを呼ばず、作業を終えてください。返しても誰にも届きません。",
    };
  }
  // スレッドを持たないセッション (スレッドを作れなかった) は追い越されようが無い。
  if (session.threadId === null) return { alive: true };

  const current = await repo.findSessionByThread(session.threadId);
  if (current && current.sessionKey !== session.sessionKey) {
    return {
      alive: false,
      status: "superseded",
      text: "このセッションは引き継がれました (同じスレッドで新しいセッションが動いています)。これ以上 kanata のツールを呼ばず、作業を終えてください。返しても誰にも届きません。",
    };
  }
  return { alive: true };
}

/**
 * この発言に添える «残量» の 1 行。値が 1 度も届いていなければ null (何も添えない)。
 * 数字は hook が転写ログから拾ってきたもので、`PreToolUse` がこの呼び出しの直前に更新している。
 */
function gauge(session: Session, env: Env): string | null {
  if (session.contextUsedTokens === null) return null;
  return contextLine(
    { usedTokens: session.contextUsedTokens, outputTokens: session.contextOutputTokens ?? 0 },
    contextWindowTokens(env.CONTEXT_WINDOW_TOKENS),
  );
}

async function askHuman(
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: Env,
  token: string | number | null,
  ctx?: Waitable,
): Promise<Response> {
  const repo = new Repo(env.DB);
  const sessionKey = typeof args.session_key === "string" ? args.session_key : "";
  const session = await repo.getSession(sessionKey);
  if (!session) {
    return textResult(
      id,
      `session_key «${sessionKey}» が見つかりません。指示の 1 行目にある KANATA- で始まる値をそのまま渡してください。`,
      true,
    );
  }

  // 終わっている / 追い越されたセッションに新しい問いを出さない (誰も答えられない)。
  const liveness = await checkAlive(repo, session);
  if (!liveness.alive) {
    return textResult(id, JSON.stringify({ status: liveness.status, next: liveness.text }), true);
  }

  // 前の往復が切れたまま残っていないか。**新しく問いを立てる前に必ず見る。**
  //
  // 握りが落ちると Claude に届くのは ask_id を含まないエラーなので、Claude にできるのは
  // これを呼び直すことだけ。素通りさせると Discord に同じ質問が 2 通出て、切れている間に
  // 入った答えは誰にも渡らない。だから «問いを作る» のではなく «拾い直す»。
  const stranded = await repo.findUndeliveredAsk(sessionKey);
  if (stranded) {
    if (stranded.answer !== null) {
      // 切れている間に人が答えていた。作り直さず、その答えをそのまま返す。
      await repo.markAskDelivered(stranded.askId);
      await repo.setStatus(sessionKey, "running");
      return textResult(
        id,
        JSON.stringify({
          status: "answered",
          ask_id: stranded.askId,
          answer: stranded.answer,
          note: "接続が切れている間に届いた、**直前の問い**への回答です。いま渡そうとした質問は出していません。",
        }),
      );
    }
    // まだ答えが無い。同じ問いが Discord に出たままなので、二重に出さず握り直す。
    return holdForAnswer(id, repo, stranded.askId, sessionKey, env, token, ctx);
  }

  const validated = validateAsk({
    sessionKey,
    question: args.question,
    options: args.options ?? [],
  });
  if (isAskProblem(validated)) return textResult(id, validated.message, true);

  const ask = await repo.createAsk({
    askId: newAskId(),
    sessionKey,
    question: validated.question,
    options: validated.options,
  });

  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const posted = await rest.postMessage(target(session), askMessage(ask, gauge(session, env)));
  if (!posted.ok) {
    // 出せていないなら «待て» と言っても永久に答えは来ない。すぐ理由を返して Claude に判断させる。
    await repo.addEvent(sessionKey, "error", `質問を出せませんでした: ${posted.detail}`);
    return textResult(
      id,
      `依頼者へ質問を出せませんでした (Discord ${posted.status})。人には届いていないので、待たずに自分の判断で進めるか、report で blocked を出してください。`,
      true,
    );
  }
  await repo.attachAskMessage(ask.askId, posted.value.id);
  await repo.setStatus(sessionKey, "waiting");

  // 作業中に書かれた文が溜まっていれば、**待たずに**それを答えとして返す。
  // ターミナルの Claude Code で «作業中に打った文が次のターンで届く» のと同じ振る舞いで、
  // これが無いと «書いたのに Claude が同じことをまた聞いてくる» になる。
  //
  // **読む (peek) → 答えにする → «渡した» 印を立てる (mark) の順を崩さない。**
  // 先に印を立てて `answerAsk` が負けると (ボタンや素の文がほぼ同時に入って先に答えた)、
  // 取り出した文は誰にも渡らないまま消える。印が後なら、負けた分はそのまま次の問いへ回る。
  const queued = await repo.peekQueued(sessionKey);
  if (queued && (await repo.answerAsk(ask.askId, queued.text, queued.authorId))) {
    const where = target(session);
    await repo.markQueuedTaken(queued.ids);
    await rest.editMessage(where, posted.value.id, askAnsweredMessage(ask, queued.text));
    await markDelivered(rest, where, queued.messageIds);
    await repo.addEvent(sessionKey, "progress", `${ask.askId} に回答 (預かっていた分)`);
    await repo.setStatus(sessionKey, "running");
    await repo.markAskDelivered(ask.askId);
    return textResult(
      id,
      JSON.stringify({ status: "answered", ask_id: ask.askId, answer: queued.text }),
    );
  }

  return holdForAnswer(id, repo, ask.askId, sessionKey, env, token, ctx);
}

async function askWait(
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: Env,
  token: string | number | null,
  ctx?: Waitable,
): Promise<Response> {
  const askId = typeof args.ask_id === "string" ? args.ask_id : "";
  const repo = new Repo(env.DB);
  const ask = await repo.getAsk(askId);
  if (!ask) return textResult(id, `ask_id «${askId}» が見つかりません。`, true);

  // 握り直す前に «まだ誰かが待っているか» を見る。見ないと、追い越されたセッションが
  // 15 分ごとに ask_wait を呼び直し続ける (誰も答えられない問いを、永久に)。
  const session = await repo.getSession(ask.sessionKey);
  if (session) {
    const liveness = await checkAlive(repo, session);
    if (!liveness.alive) {
      return textResult(id, JSON.stringify({ status: liveness.status, next: liveness.text }), true);
    }
  }
  return holdForAnswer(id, repo, askId, ask.sessionKey, env, token, ctx);
}

/**
 * 答えが入るまで SSE のストリームを握り続ける。
 *
 * ストリームを **先に返してから** 書き続けるのが肝。最初の 1 バイトが出た時点でエッジの
 * «応答が始まらない» タイマーは満たされ、あとは ping が沈黙を作らない。握っている間
 * Claude 側では 1 つのツール呼び出しが未完了のまま止まっているだけなので、API リクエストは飛ばない。
 */
function holdForAnswer(
  id: JsonRpcId,
  repo: Repo,
  askId: string,
  sessionKey: string,
  env: Env,
  token: string | number | null,
  ctx?: Waitable,
): Response {
  const { holdMs, pollMs, pingMs } = holdConfig(env);

  // **progressToken が無いと、クライアントから見てこの握りは «完全な沈黙» になる。**
  // SSE のコメント行は JSON-RPC メッセージではないので、Claude Code の 5 分の idle abort
  // (`CLIENT_IDLE_ABORT_MS`) を止められない。黙って落とされる前に自分から降りて
  // `ask_wait` へ引き継ぐ — «pending が返る» なら失敗ではなく、答えも往復も失われない。
  const limitMs = token === null ? Math.min(holdMs, SILENT_HOLD_MS) : holdMs;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (chunk: string) => writer.write(encoder.encode(chunk));
  const sendMessage = (message: unknown) => write(`data: ${JSON.stringify(message)}\n\n`);

  const pump = async (): Promise<void> => {
    try {
      // 最初の 1 バイト。これが出るまでがエッジの勝負どころ。
      await write(": kanata\n\n");
      const deadline = Date.now() + limitMs;
      let lastPing = Date.now();
      let ticks = 0;

      for (;;) {
        const ask = await repo.getAsk(askId);
        if (ask?.answer != null) {
          await sendMessage(
            toolResult(
              id,
              JSON.stringify({ status: "answered", ask_id: askId, answer: ask.answer }),
            ),
          );
          // 書き出せたことが «渡せた» の唯一の手掛かり。ここを立てないと、次の ask_human が
          // 同じ答えを何度も返し続ける。
          await repo.markAskDelivered(askId);
          return;
        }
        if (Date.now() >= deadline) {
          await sendMessage(
            toolResult(
              id,
              JSON.stringify({
                status: "pending",
                ask_id: askId,
                next: "接続を握れる上限に達しました。同じ ask_id で ask_wait を呼び直してください。まだ人が answer していません。",
              }),
            ),
          );
          return;
        }
        if (Date.now() - lastPing >= pingMs) {
          // 待っている間に «待つ意味» が消えることがある — 同じスレッドで新しいセッションが
          // 起こされた / このセッションが終わった。気づかずに握り続けると、答えの来ない問いを
          // 15 分ごとに握り直し続ける。ping のたびに 1 回だけ見る。
          const session = await repo.getSession(sessionKey);
          const liveness = session ? await checkAlive(repo, session) : null;
          if (liveness && !liveness.alive) {
            await sendMessage(
              toolResult(
                id,
                JSON.stringify({ status: liveness.status, next: liveness.text }),
                true,
              ),
            );
            return;
          }

          // コメント行は沈黙を作らないため。progress 通知は MCP 側の idle 判定のため。
          // touchSession は «このセッションはまだ生きている» の印 (domain/inbound.ts が見る)。
          await repo.touchSession(sessionKey);
          await write(": ping\n\n");
          if (token !== null) {
            ticks += 1;
            await sendMessage({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress: ticks,
                message: "依頼者の回答を待っています",
              },
            });
          }
          lastPing = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } catch {
      // 相手が切った / 書けなくなった。握りを諦めるだけで、回答は D1 に残るので ask_wait で拾える。
    } finally {
      await writer.close().catch(() => {});
    }
  };

  const running = pump();
  // ストリームが閉じるまで Worker を生かす。await しない (先に Response を返す)。
  ctx?.waitUntil(running);

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function report(id: JsonRpcId, args: Record<string, unknown>, env: Env): Promise<Response> {
  const repo = new Repo(env.DB);
  const sessionKey = typeof args.session_key === "string" ? args.session_key : "";
  const session = await repo.getSession(sessionKey);
  if (!session) return textResult(id, `session_key «${sessionKey}» が見つかりません。`, true);

  const kind = typeof args.kind === "string" ? args.kind : "progress";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (text === "") return textResult(id, "text が空です。", true);

  await repo.addEvent(sessionKey, kind, text);
  if (kind === "done") await repo.setStatus(sessionKey, "done");

  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const posted = await rest.postMessage(
    target(session),
    reportMessage(kind, text, gauge(session, env)),
  );
  if (!posted.ok) {
    return textResult(id, `記録はしましたが Discord へ出せませんでした (${posted.status})。`);
  }
  return textResult(id, "依頼者へ伝えました。");
}
