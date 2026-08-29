import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db/repo";
import { handleMcp } from "./server";

/**
 * ask_human の往復 = このプロジェクトで一番壊れると困るところ。
 * 「質問を出す → まだ答えが無い → 答えが入る → 待ち直しで受け取る」を通しで固める。
 *
 * 時間では待たない (待ちの長さは env で 60ms に縮めてある)。
 */

/**
 * 外向きの fetch は 1 本しか無い (Discord への投稿) ので、素の差し替えで足りる。
 * 実ネットワークには決して出ない — 予定に無い宛先は例外にして気づけるようにする。
 */
type DiscordCall = { url: string; body: unknown };

let calls: DiscordCall[] = [];
let replies: Map<string, { status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  replies = new Map();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const reply = replies.get(url);
    if (!reply) throw new Error(`予定に無い宛先へ fetch しました: ${url}`);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function rpcJson(request: Request): Promise<unknown> {
  const response = await handleMcp(request, env);
  return await response.json();
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
      (tool) => tool.name,
    );
    expect(names).toEqual(["ask_human", "ask_wait", "report"]);
  });

  it("知らないメソッドはエラーで返す", async () => {
    const body = await rpcJson(rpc("nope"));
    expect(body).toHaveProperty("error");
  });
});

describe("ask_human", () => {
  it("知らない session_key は理由つきで断る", async () => {
    const body = await rpcJson(
      rpc("tools/call", {
        name: "ask_human",
        arguments: { session_key: "KANATA-ffffffffffffffff", question: "どれ" },
      }),
    );
    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("見つかりません");
  });

  it("質問を出して «まだ答えが無い» を返し、答えが入ったら待ち直しで受け取れる", async () => {
    const sessionKey = "KANATA-aaaabbbbccccdddd";
    const repo = await seedSession(sessionKey, "th-1");
    expectDiscordPost("th-1", "msg-1");

    const asked = await rpcJson(
      rpc("tools/call", {
        name: "ask_human",
        arguments: { session_key: sessionKey, question: "A か B か", options: ["A", "B"] },
      }),
    );
    const pending = JSON.parse(toolText(asked));
    expect(pending.status).toBe("pending");
    expect(pending.ask_id).toMatch(/^ask_[0-9a-f]{16}$/);

    // 質問を出した時点で «待ち» に落ちている。押した先の Discord メッセージも覚えている。
    expect((await repo.getSession(sessionKey))?.status).toBe("waiting");
    expect((await repo.getAsk(pending.ask_id))?.messageId).toBe("msg-1");

    expect(await repo.answerAsk(pending.ask_id, "A", "owner-1")).toBe(true);

    const answered = await rpcJson(
      rpc("tools/call", { name: "ask_wait", arguments: { ask_id: pending.ask_id } }),
    );
    expect(JSON.parse(toolText(answered))).toMatchObject({ status: "answered", answer: "A" });
  });

  it("二度目の回答は書き込まない (連打で答えが上書きされない)", async () => {
    const sessionKey = "KANATA-1111222233334444";
    const repo = await seedSession(sessionKey, "th-2");
    expectDiscordPost("th-2", "msg-2");

    const asked = await rpcJson(
      rpc("tools/call", {
        name: "ask_human",
        arguments: { session_key: sessionKey, question: "どれ", options: ["A", "B"] },
      }),
    );
    const askId = JSON.parse(toolText(asked)).ask_id;

    expect(await repo.answerAsk(askId, "A", "owner-1")).toBe(true);
    expect(await repo.answerAsk(askId, "B", "owner-1")).toBe(false);
    expect((await repo.getAsk(askId))?.answer).toBe("A");
  });

  it("Discord へ出せなかったら待たせず、待つなと伝える", async () => {
    const sessionKey = "KANATA-5555666677778888";
    await seedSession(sessionKey, "th-3");
    expectDiscordPost("th-3", "", 403);

    const body = await rpcJson(
      rpc("tools/call", {
        name: "ask_human",
        arguments: { session_key: sessionKey, question: "どれ" },
      }),
    );
    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("待たずに");
  });

  it("答える手段が無い質問は作らせない", async () => {
    const sessionKey = "KANATA-9999aaaabbbbcccc";
    await seedSession(sessionKey, "th-4");
    const body = await rpcJson(
      rpc("tools/call", {
        name: "ask_human",
        arguments: {
          session_key: sessionKey,
          question: "どれ",
          options: [],
          allow_free_text: false,
        },
      }),
    );
    expect(isToolError(body)).toBe(true);
  });
});

describe("report", () => {
  it("done でセッションを終わりにし、スレッドへ出す", async () => {
    const sessionKey = "KANATA-ddddeeeeffff0000";
    const repo = await seedSession(sessionKey, "th-5");
    expectDiscordPost("th-5", "msg-5");

    const body = await rpcJson(
      rpc("tools/call", {
        name: "report",
        arguments: { session_key: sessionKey, kind: "done", text: "PR を作りました" },
      }),
    );
    expect(isToolError(body)).toBe(false);
    expect((await repo.getSession(sessionKey))?.status).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("空の本文は断る", async () => {
    const sessionKey = "KANATA-0000111122223333";
    await seedSession(sessionKey, "th-6");
    const body = await rpcJson(
      rpc("tools/call", {
        name: "report",
        arguments: { session_key: sessionKey, kind: "progress", text: "  " },
      }),
    );
    expect(isToolError(body)).toBe(true);
  });
});
