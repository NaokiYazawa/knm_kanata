import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db/repo";
import { applyInbound } from "./inbound";

/**
 * Gateway が拾った «素の文» を実際に処理する層。
 *
 * ここが守るのは 1 つ: **書いた文がどこにも行かずに消える経路を作らない**。
 * 回答になるか、溜まるか、新しいセッションの指示になるかのどれかで、
 * «何も起きないのに何も言わない» のは kanata の会話ではないスレッドのときだけ。
 */

let seen: string[] = [];
let replies: Map<string, { status: number; body: unknown }>;

beforeEach(() => {
  seen = [];
  replies = new Map();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const reply = replies.get(url);
    if (!reply) throw new Error(`予定に無い宛先へ fetch しました: ${url}`);
    seen.push(url);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

const FIRE = "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire";

async function seed(sessionKey: string, threadId: string): Promise<Repo> {
  const repo = new Repo(env.DB);
  await repo.createSession({
    sessionKey,
    project: "demo",
    prompt: "最初の指示",
    requesterId: "owner-1",
    channelId: "ch-1",
  });
  await repo.attachThread(sessionKey, threadId);
  return repo;
}

function message(
  threadId: string,
  text: string,
  overrides: Partial<Parameters<typeof applyInbound>[1]> = {},
) {
  return applyInbound(env, {
    threadId,
    messageId: "m-1",
    authorId: "owner-1",
    authorIsBot: false,
    text,
    ...overrides,
  });
}

describe("素の文の取り込み", () => {
  it("待っている質問があれば回答になり、押し口 (ボタン) が消える", async () => {
    const repo = await seed("KANATA-a1a1a1a1a1a1a1a1", "th-a");
    const ask = await repo.createAsk({
      askId: "ask_00000000000000a1",
      sessionKey: "KANATA-a1a1a1a1a1a1a1a1",
      question: "次は？",
      options: ["おわり"],
      allowFreeText: true,
    });
    await repo.attachAskMessage(ask.askId, "msg-ask");
    await repo.setStatus("KANATA-a1a1a1a1a1a1a1a1", "waiting");

    replies.set("https://discord.com/api/v10/channels/th-a/messages/msg-ask", {
      status: 200,
      body: { id: "msg-ask" },
    });

    expect(await message("th-a", "テストも書いて")).toEqual({
      kind: "answered",
      askId: ask.askId,
    });
    expect((await repo.getAsk(ask.askId))?.answer).toBe("テストも書いて");
    expect((await repo.getSession("KANATA-a1a1a1a1a1a1a1a1"))?.status).toBe("running");
  });

  it("作業中なら溜めて、預かった印だけを付ける (チャットに 1 行足さない)", async () => {
    const repo = await seed("KANATA-b2b2b2b2b2b2b2b2", "th-b");
    await repo.setStatus("KANATA-b2b2b2b2b2b2b2b2", "running");

    replies.set(
      "https://discord.com/api/v10/channels/th-b/messages/m-1/reactions/%F0%9F%91%80/@me",
      { status: 204, body: null },
    );

    expect(await message("th-b", "この後 README も直して")).toEqual({ kind: "queued" });
    // 「受け取りました」を投稿しない — 素の会話が bot の相槌で埋まる。
    expect(seen.some((url) => url.endsWith("/messages"))).toBe(false);
    expect(await repo.takeQueued("KANATA-b2b2b2b2b2b2b2b2")).toEqual({
      text: "この後 README も直して",
      authorId: "owner-1",
      messageIds: ["m-1"],
    });
  });

  it("溜まっていた文は書いた順に 1 つへ畳んで渡す", async () => {
    const repo = await seed("KANATA-c3c3c3c3c3c3c3c3", "th-c");
    await repo.setStatus("KANATA-c3c3c3c3c3c3c3c3", "running");
    for (const id of ["m-1", "m-2"]) {
      replies.set(
        `https://discord.com/api/v10/channels/th-c/messages/${id}/reactions/%F0%9F%91%80/@me`,
        { status: 204, body: null },
      );
    }

    await message("th-c", "まず A");
    await message("th-c", "あと B も", { messageId: "m-2" });

    // Claude が聞きに来られるのは 1 回で、答えられるのも 1 回だから 1 つに畳む。
    expect((await repo.takeQueued("KANATA-c3c3c3c3c3c3c3c3"))?.text).toBe("まず A\nあと B も");
  });

  it("終わったスレッドでは、溜めていた分ごと新しいセッションへ渡す", async () => {
    const repo = await seed("KANATA-d4d4d4d4d4d4d4d4", "th-d");
    await repo.queueMessage({
      sessionKey: "KANATA-d4d4d4d4d4d4d4d4",
      threadId: "th-d",
      authorId: "owner-1",
      messageId: null,
      body: "渡しそびれていた指示",
    });
    await repo.setStatus("KANATA-d4d4d4d4d4d4d4d4", "done");

    replies.set("https://discord.com/api/v10/channels/th-d/messages", {
      status: 200,
      body: { id: "msg-note" },
    });
    replies.set(FIRE, {
      status: 200,
      body: {
        claude_code_session_id: "session_d",
        claude_code_session_url: "https://claude.ai/code/session_d",
      },
    });

    const outcome = await message("th-d", "やっぱりログも足して");
    expect(outcome.kind).toBe("restarted");

    // 預かっていたぶんを捨てない (捨てると «預かったのに何も起きなかった» になる)。
    const started = (await repo.listRecentSessions(10)).find((s) => s.threadId === "th-d");
    expect(started?.prompt).toBe("渡しそびれていた指示\nやっぱりログも足して");
    expect(started?.status).toBe("running");
    expect(seen).toContain(FIRE);
  });

  it("kanata の会話ではないところでは、何も起きず何も出さない", async () => {
    expect(await message("ch-general", "ただの雑談")).toEqual({
      kind: "ignored",
      reason: "このスレッドにセッションが無い",
    });
    expect(seen).toEqual([]);
  });

  it("自分の投稿を拾い直さない (質問文が入力として返ってくる)", async () => {
    await seed("KANATA-e5e5e5e5e5e5e5e5", "th-e");
    expect((await message("th-e", "次は？", { authorIsBot: true })).kind).toBe("ignored");
    expect(seen).toEqual([]);
  });

  it("持ち主以外の発言は拾わない", async () => {
    await seed("KANATA-f6f6f6f6f6f6f6f6", "th-f");
    expect((await message("th-f", "こんにちは", { authorId: "someone-else" })).kind).toBe(
      "ignored",
    );
    expect(seen).toEqual([]);
  });
});
