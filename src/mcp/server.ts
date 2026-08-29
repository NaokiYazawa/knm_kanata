import { Repo, type Session } from "../db/repo";
import { askMessage, reportMessage } from "../discord/components";
import { DiscordRest } from "../discord/rest";
import { isAskProblem, validateAsk } from "../domain/ask";
import { newAskId } from "../domain/ids";
import type { Env } from "../env";

/**
 * Worker 自身が MCP サーバーになる。cloud session はここへ繋いで **人に聞きに来る**。
 *
 * なぜこの形か: Claude Code on the web には «走っているセッションへ外から発言を差し込む»
 * 公式 HTTP API が無い。だから «こちらから話しかける» のを諦め、**セッション側から聞かせる**。
 * ツール呼び出しは Claude の turn を止めるので、人が答えるまで待たせられる。
 *
 * 待ち方に 2 つの制約がある:
 *  - Cloudflare のエッジは応答が始まらないまま 100 秒ほど経つと切る
 *  - Claude Code は 2 分を超えたツール呼び出しをバックグラウンドタスクへ回す
 * どちらにも当たらないよう **1 回の待ちは 75 秒で切り上げ**、答えが無ければ «まだです» を返して
 * `ask_wait` を呼び直させる。待ち続ける責務を Claude 側のループに持たせる。
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

const DEFAULT_WAIT_BUDGET_MS = 75_000;
const DEFAULT_WAIT_POLL_MS = 2_000;

/**
 * 待ちの長さを env で動かせるようにしてある。テストで 75 秒待たないためであり、
 * 本番で伸ばすためではない (75 秒より長くするとエッジ側で切られる)。
 */
function waitConfig(env: Env): { budgetMs: number; pollMs: number } {
  const budgetMs = Number(env.ASK_WAIT_BUDGET_MS ?? "");
  const pollMs = Number(env.ASK_POLL_MS ?? "");
  return {
    budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_WAIT_BUDGET_MS,
    pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_WAIT_POLL_MS,
  };
}

const SERVER_INFO = { name: "kanata", version: "0.1.0" };

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function result(id: string | number | null, value: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: value }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: string | number | null, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: { "content-type": "application/json" },
  });
}

function textResult(id: string | number | null, text: string, isError = false): Response {
  return result(id, { content: [{ type: "text", text }], isError });
}

const TOOLS = [
  {
    name: "ask_human",
    title: "依頼者に確認する",
    description:
      "判断が要ることを依頼者に確認し、答えが返るまで待つ。選択肢はボタン、自由記述はフォームとして Discord に出る。返り値が status:pending なら同じ ask_id で ask_wait を呼び直すこと。",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", description: "指示の 1 行目にある KANATA- で始まる値" },
        question: { type: "string", description: "確認したいこと。前提も含めて自己完結させる" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "選ばせたい選択肢 (最大 20 個)。自由に書いてほしいときは省略する",
        },
        allow_free_text: {
          type: "boolean",
          description: "自由記述の口を出すか (既定 true)",
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
      "依頼者のスレッドへ進捗を出す。kind は progress / blocked / done。done は最後に必ず 1 回呼ぶ。",
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

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "JSON として読めません");
  }

  const id = body.id ?? null;
  const method = body.method ?? "";

  // 通知 (id なし) は受け取ったことだけ返す。
  if (body.id === undefined || body.id === null) {
    if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
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
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, body.params ?? {}, env);
    default:
      return rpcError(id, -32601, `未対応のメソッド: ${method}`);
  }
}

async function callTool(
  id: string | number | null,
  params: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "ask_human":
      return askHuman(id, args, env);
    case "ask_wait":
      return askWait(id, args, env);
    case "report":
      return report(id, args, env);
    default:
      return textResult(id, `未対応のツール: ${name}`, true);
  }
}

function target(session: Session): string {
  return session.threadId ?? session.channelId;
}

async function askHuman(
  id: string | number | null,
  args: Record<string, unknown>,
  env: Env,
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

  const validated = validateAsk({
    sessionKey,
    question: args.question,
    options: args.options ?? [],
    allowFreeText: args.allow_free_text,
  });
  if (isAskProblem(validated)) return textResult(id, validated.message, true);

  const ask = await repo.createAsk({
    askId: newAskId(),
    sessionKey,
    question: validated.question,
    options: validated.options,
    allowFreeText: validated.allowFreeText,
  });

  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const posted = await rest.postMessage(target(session), askMessage(ask));
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

  return waitForAnswer(id, repo, ask.askId, env);
}

async function askWait(
  id: string | number | null,
  args: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const askId = typeof args.ask_id === "string" ? args.ask_id : "";
  const repo = new Repo(env.DB);
  const ask = await repo.getAsk(askId);
  if (!ask) return textResult(id, `ask_id «${askId}» が見つかりません。`, true);
  return waitForAnswer(id, repo, askId, env);
}

async function waitForAnswer(
  id: string | number | null,
  repo: Repo,
  askId: string,
  env: Env,
): Promise<Response> {
  const { budgetMs, pollMs } = waitConfig(env);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const ask = await repo.getAsk(askId);
    if (ask?.answer != null) {
      return textResult(
        id,
        JSON.stringify({ status: "answered", ask_id: askId, answer: ask.answer }),
      );
    }
    if (Date.now() + pollMs >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return textResult(
    id,
    JSON.stringify({
      status: "pending",
      ask_id: askId,
      next: "同じ ask_id で ask_wait をもう一度呼んでください。まだ人が答えていません。",
    }),
  );
}

async function report(
  id: string | number | null,
  args: Record<string, unknown>,
  env: Env,
): Promise<Response> {
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
  const posted = await rest.postMessage(target(session), reportMessage(kind, text));
  if (!posted.ok) {
    return textResult(id, `記録はしましたが Discord へ出せませんでした (${posted.status})。`);
  }
  return textResult(id, "依頼者へ伝えました。");
}
