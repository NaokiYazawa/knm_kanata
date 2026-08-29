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

/**
 * 握りは落ちる (実測: 15 分・6 分 22 秒は握れたのに、別の回は 5 分 00 秒で切れた)。
 * 落ちたとき Claude に届くのは **ask_id を含まない**エラーなので、`ask_wait` では戻れない。
 * Claude にできるのは `ask_human` を呼び直すことだけで、それが素通りすると
 * 「同じ質問が Discord に 2 通」「切れている間の答えが宙に浮く」が同時に起きる。
 *
 * 2026-08-29 14:38 の質問を実際に 1 つ失った経路なので、両側をここで固める。
 */
describe("握りが落ちた後の呼び直し", () => {
  it("答えがもう入っていたら、質問を出し直さずその答えを返す", async () => {
    const sessionKey = "KANATA-99998888aaaabbbb";
    const repo = await seedSession(sessionKey, "th-drop");
    expectDiscordPost("th-drop", "msg-drop");

    // 1 回目。ここで握りが «落ちた» ことにする (応答は読み捨てる)。
    const first = await handleMcp(askCall(sessionKey, { question: "長い回答その 1" }), env);
    void first.body?.cancel();
    const ask = await repo.findOpenAsk(sessionKey);

    // 切れている間に人が答えた。
    expect(await repo.answerAsk(ask?.askId ?? "", "本当に聞きたかったこと", "owner-1")).toBe(true);

    // Claude は ask_id を持っていないので ask_human を呼び直すしかない。
    const retry = await handleMcp(askCall(sessionKey, { question: "(再送)" }), env);
    const payload = JSON.parse(toolText(await retry.json()));
    expect(payload).toMatchObject({
      status: "answered",
      ask_id: ask?.askId,
      answer: "本当に聞きたかったこと",
    });

    // **質問は 1 通しか出ていない** (Discord への投稿は 1 回だけ)。
    expect(calls.filter((c) => c.url.endsWith("/messages")).length).toBe(1);
    expect((await repo.getSession(sessionKey))?.status).toBe("running");
  });

  it("まだ答えが無いなら、二重に出さず同じ問いを握り直す", async () => {
    const sessionKey = "KANATA-7777666655554444";
    const repo = await seedSession(sessionKey, "th-again");
    expectDiscordPost("th-again", "msg-again");

    const first = await handleMcp(askCall(sessionKey, { question: "長い回答その 2" }), env);
    void first.body?.cancel();
    const ask = await repo.findOpenAsk(sessionKey);

    const retry = await handleMcp(askCall(sessionKey, { question: "(再送)" }), env);
    // 握り直しているので SSE で戻る。
    expect(retry.headers.get("content-type")).toContain("text/event-stream");
    await repo.answerAsk(ask?.askId ?? "", "あとから答えた", "owner-1");
    const messages = await readSse(retry);
    expect(JSON.parse(toolText(messages[messages.length - 1]))).toMatchObject({
      ask_id: ask?.askId,
      answer: "あとから答えた",
    });

    // 出た質問はやはり 1 通だけ。
    expect(calls.filter((c) => c.url.endsWith("/messages")).length).toBe(1);
  });

  it("渡し終えた問いを蘇らせない (次の質問はちゃんと新しく出る)", async () => {
    const sessionKey = "KANATA-3333222211110000";
    const repo = await seedSession(sessionKey, "th-next");
    expectDiscordPost("th-next", "msg-next");

    const first = await handleMcp(askCall(sessionKey, { question: "1 つめ" }), env);
    const askId = (await repo.findOpenAsk(sessionKey))?.askId ?? "";
    await repo.answerAsk(askId, "A案", "owner-1");
    await readSse(first); // 握りが答えを渡し切る

    const second = await handleMcp(askCall(sessionKey, { question: "2 つめ" }), env);
    expect(second.headers.get("content-type")).toContain("text/event-stream");
    void second.body?.cancel();

    const latest = await repo.findOpenAsk(sessionKey);
    expect(latest?.askId).not.toBe(askId);
    expect(latest?.question).toBe("2 つめ");
    expect(calls.filter((c) => c.url.endsWith("/messages")).length).toBe(2);
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

    const ask = await repo.findOpenAsk(sessionKey);
    expect(ask?.messageId).toBe("msg-1");
    expect((await repo.getSession(sessionKey))?.status).toBe("waiting");

    // 握っている最中に人が答える。
    expect(await repo.answerAsk(ask?.askId ?? "", "A案", "owner-1")).toBe(true);

    const messages = await readSse(response);
    const last = messages[messages.length - 1];
    expect(JSON.parse(toolText(last))).toMatchObject({ status: "answered", answer: "A案" });
  });

  it("作業中に書かれた文が溜まっていたら、握らずに即座にそれを答えとして返す", async () => {
    // ターミナルの Claude Code で «作業中に打った文が次のターンで届く» のと同じ。
    // これが無いと «書いたのに Claude が同じことをまた聞いてくる» になる。
    const sessionKey = "KANATA-5555666677778888";
    const repo = await seedSession(sessionKey, "th-q");
    await repo.queueMessage({
      sessionKey,
      threadId: "th-q",
      authorId: "owner-1",
      messageId: "m-9",
      body: "この後 README も直して",
    });
    expectDiscordPost("th-q", "msg-q");
    // 質問を «回答済み» の姿へ差し替え、預かった印を渡した印へ付け替える。
    replies.set("https://discord.com/api/v10/channels/th-q/messages/msg-q", {
      status: 200,
      body: { id: "msg-q" },
    });
    for (const emoji of ["%E2%9C%85", "%F0%9F%91%80"]) {
      replies.set(`https://discord.com/api/v10/channels/th-q/messages/m-9/reactions/${emoji}/@me`, {
        status: 204,
        body: null,
      });
    }

    const response = await handleMcp(askCall(sessionKey), env);
    // 握らない = SSE ではなく素の JSON で即座に返る。
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(toolText(await response.json()))).toMatchObject({
      status: "answered",
      answer: "この後 README も直して",
    });
    expect((await repo.getSession(sessionKey))?.status).toBe("running");
    // 二度は渡らない。
    expect(await repo.takeQueued(sessionKey)).toBeNull();
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
