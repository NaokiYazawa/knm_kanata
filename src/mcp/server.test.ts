import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db/repo";
import { DEFAULTS, handleMcp, OBSERVED_EDGE_CUTOFF_MS } from "./server";

/**
 * ask_human の往復 = このプロジェクトで一番壊れると困るところ。
 * 「質問を出す → 握ったまま待つ → 答えが入る → 同じ呼び出しの返り値として届く」を通しで固める。
 *
 * 時間では待たない (握りの上限は env で 1.5 秒に縮めてある)。
 */

type DiscordCall = { url: string; body: unknown };

let calls: DiscordCall[] = [];
let replies: Map<string, { status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  replies = new Map();
  // 外向きの fetch は Discord への投稿だけ。予定に無い宛先は例外にして気づけるようにする。
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const reply = replies.get(url);
    if (!reply) throw new Error(`予定に無い宛先へ fetch しました: ${url}`);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

function rpc(method: string, params?: unknown, id: number | string = 1): Request {
  return new Request("https://kanata.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function rpcJson(request: Request): Promise<unknown> {
  return await (await handleMcp(request, env)).json();
}

/** SSE の本文を JSON-RPC メッセージの列に開く。 */
async function readSse(response: Response): Promise<Record<string, never>[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

function toolText(body: unknown): string {
  const result = (body as { result?: { content?: { text?: string }[] } }).result;
  return result?.content?.[0]?.text ?? "";
}

function isToolError(body: unknown): boolean {
  return (body as { result?: { isError?: boolean } }).result?.isError === true;
}

async function seedSession(sessionKey: string, threadId: string): Promise<Repo> {
  const repo = new Repo(env.DB);
  await repo.createSession({
    sessionKey,
    project: "demo",
    prompt: "テスト",
    requesterId: "owner-1",
    channelId: "ch-1",
  });
  await repo.attachThread(sessionKey, threadId);
  return repo;
}

function expectDiscordPost(channelId: string, messageId: string, status = 200): void {
  replies.set(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    status,
    body: { id: messageId },
  });
}

function askCall(sessionKey: string, extra: Record<string, unknown> = {}, meta?: unknown): Request {
  return rpc("tools/call", {
    name: "ask_human",
    arguments: { session_key: sessionKey, question: "A か B か", ...extra },
    ...(meta === undefined ? {} : { _meta: meta }),
  });
}

describe("MCP のハンドシェイク", () => {
  it("クライアントが名乗ったバージョンで合意する", async () => {
    const body = await rpcJson(rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(body).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "kanata" } },
    });
  });

  it("知らないバージョンなら自分の最新を返す", async () => {
    const body = await rpcJson(rpc("initialize", { protocolVersion: "1999-01-01" }));
    expect((body as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      "2025-11-25",
    );
  });

  it("通知は 202 で受け取る", async () => {
    const request = new Request("https://kanata.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect((await handleMcp(request, env)).status).toBe(202);
  });

  it("3 つの道具を出す", async () => {
    const body = await rpcJson(rpc("tools/list"));
    const names = (body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toEqual(["ask_human", "ask_wait", "report"]);
  });

  it("知らないメソッドはエラーで返す", async () => {
    expect(await rpcJson(rpc("nope"))).toHaveProperty("error");
  });
});

describe("ask_human の握り", () => {
  it("知らない session_key は握らず、その場で断る", async () => {
    const response = await handleMcp(askCall("KANATA-ffffffffffffffff"), env);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("見つかりません");
  });

  it("答えが入るまで握り、同じ呼び出しの返り値として返す", async () => {
    const sessionKey = "KANATA-aaaabbbbccccdddd";
    const repo = await seedSession(sessionKey, "th-1");
    expectDiscordPost("th-1", "msg-1");

    // 握りは «Response を先に返してから» 書き続けるので、ここは即座に戻る。
    const response = await handleMcp(askCall(sessionKey, { options: ["A案", "B案"] }), env);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const ask = await repo.findLiveAskInThread("th-1", new Date(0).toISOString());
    expect(ask?.messageId).toBe("msg-1");
    expect((await repo.getSession(sessionKey))?.status).toBe("waiting");

    // 握っている最中に人が答える。
    expect(await repo.answerAsk(ask?.askId ?? "", "A案", "owner-1")).toBe(true);

    const messages = await readSse(response);
    const last = messages[messages.length - 1];
    expect(JSON.parse(toolText(last))).toMatchObject({ status: "answered", answer: "A案" });
  });

  it("握り切れなかったら pending を返して ask_wait に引き継ぐ", async () => {
    const sessionKey = "KANATA-1111222233334444";
    const repo = await seedSession(sessionKey, "th-2");
    expectDiscordPost("th-2", "msg-2");

    const messages = await readSse(await handleMcp(askCall(sessionKey), env));
    const payload = JSON.parse(toolText(messages[messages.length - 1]));
    expect(payload.status).toBe("pending");
    expect(payload.ask_id).toMatch(/^ask_[0-9a-f]{16}$/);

    // 引き継いだ先でも同じように握れる。
    const ask = await repo.getAsk(payload.ask_id);
    expect(ask?.answer).toBeNull();
    const again = await handleMcp(
      rpc("tools/call", { name: "ask_wait", arguments: { ask_id: payload.ask_id } }),
      env,
    );
    await repo.answerAsk(payload.ask_id, "あとから答えた", "owner-1");
    const resumed = await readSse(again);
    expect(JSON.parse(toolText(resumed[resumed.length - 1]))).toMatchObject({
      status: "answered",
      answer: "あとから答えた",
    });
  });

  it("progressToken が渡されていれば progress 通知を流す (idle 判定に殺されないため)", async () => {
    const sessionKey = "KANATA-5555666677778888";
    await seedSession(sessionKey, "th-3");
    expectDiscordPost("th-3", "msg-3");

    const messages = await readSse(
      await handleMcp(askCall(sessionKey, {}, { progressToken: "tok-1" }), env),
    );
    const progress = messages.filter(
      (m) => (m as { method?: string }).method === "notifications/progress",
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ params: { progressToken: "tok-1" } });
  });

  it("progressToken が無ければ progress 通知は流さない (仕様: 渡された token にしか紐付けない)", async () => {
    const sessionKey = "KANATA-9999aaaabbbbcccc";
    await seedSession(sessionKey, "th-4");
    expectDiscordPost("th-4", "msg-4");

    const messages = await readSse(await handleMcp(askCall(sessionKey), env));
    expect(
      messages.some((m) => (m as { method?: string }).method === "notifications/progress"),
    ).toBe(false);
  });

  it("Discord へ出せなかったら握らず、待つなと伝える", async () => {
    const sessionKey = "KANATA-ddddeeeeffff0000";
    await seedSession(sessionKey, "th-5");
    expectDiscordPost("th-5", "", 403);

    const body = await (await handleMcp(askCall(sessionKey), env)).json();
    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("待たずに");
  });

  it("答える手段が無い質問は作らせない", async () => {
    const sessionKey = "KANATA-0000111122223333";
    await seedSession(sessionKey, "th-6");
    const body = await (
      await handleMcp(askCall(sessionKey, { options: [], allow_free_text: false }), env)
    ).json();
    expect(isToolError(body)).toBe(true);
  });
});

describe("report", () => {
  it("done でセッションを終わりにし、スレッドへ出す", async () => {
    const sessionKey = "KANATA-4444555566667777";
    const repo = await seedSession(sessionKey, "th-7");
    expectDiscordPost("th-7", "msg-7");

    const body = await (
      await handleMcp(
        rpc("tools/call", {
          name: "report",
          arguments: { session_key: sessionKey, kind: "done", text: "PR を作りました" },
        }),
        env,
      )
    ).json();
    expect(isToolError(body)).toBe(false);
    expect((await repo.getSession(sessionKey))?.status).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("空の本文は断る", async () => {
    const sessionKey = "KANATA-8888999900001111";
    await seedSession(sessionKey, "th-8");
    const body = await (
      await handleMcp(
        rpc("tools/call", {
          name: "report",
          arguments: { session_key: sessionKey, kind: "progress", text: "  " },
        }),
        env,
      )
    ).json();
    expect(isToolError(body)).toBe(true);
  });
});

describe("握りの前提", () => {
  it("ping の間隔がエッジの限界より十分内側にある", () => {
    // 応答が始まらないまま握るとエッジが 502 を返す。SSE でも «沈黙» が続けば同じなので、
    // ping はその半分より内側に置く。伸ばす向きの変更をここで止める。
    expect(DEFAULTS.pingMs * 2).toBeLessThan(OBSERVED_EDGE_CUTOFF_MS);
  });
});
