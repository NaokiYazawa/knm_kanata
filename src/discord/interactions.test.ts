import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db/repo";
import { handleInteraction } from "./interactions";

/**
 * `/claude` は 1 つのコマンドで 2 つの意味を持つ。
 * 待っている質問があればその **回答**、無ければ新しいセッションの **起動**。
 * スレッドが 1 本の会話に見えるかどうかは、この分岐が正しいかにかかっている。
 */

let seen: string[] = [];
let replies: Map<string, { status: number; body: unknown }>;
let pending: Promise<unknown>[] = [];

const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

beforeEach(() => {
  seen = [];
  pending = [];
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

function command(task: string, channelId: string, userId = "owner-1"): never {
  return {
    type: 2,
    token: "itok",
    channel: { id: channelId, type: 11 },
    member: { user: { id: userId } },
    data: { name: "claude", options: [{ name: "task", value: task }] },
  } as never;
}

async function settle(): Promise<void> {
  await Promise.all(pending);
}

describe("/claude", () => {
  it("待っている質問があれば、新規起動せず «続き» として渡す", async () => {
    const repo = new Repo(env.DB);
    await repo.createSession({
      sessionKey: "KANATA-1234123412341234",
      project: "demo",
      prompt: "最初の指示",
      requesterId: "owner-1",
      channelId: "ch-1",
    });
    await repo.attachThread("KANATA-1234123412341234", "th-live");
    const ask = await repo.createAsk({
      askId: "ask_00000000feedbeef",
      sessionKey: "KANATA-1234123412341234",
      question: "次は何をしますか？",
      options: ["おわり"],
      allowFreeText: true,
    });
    await repo.attachAskMessage(ask.askId, "msg-live");
    await repo.setStatus("KANATA-1234123412341234", "waiting");

    // 質問メッセージを «回答済み» の姿へ差し替える PATCH だけが飛ぶ。
    replies.set("https://discord.com/api/v10/channels/th-live/messages/msg-live", {
      status: 200,
      body: { id: "msg-live" },
    });

    const response = await handleInteraction(command("テストも書いて", "th-live"), env, ctx);
    const body = (await response.json()) as { type: number };
    expect(body.type).toBe(4);

    await settle();

    // 回答として入り、セッションは走行中へ戻り、**新しいセッションは作られていない**。
    expect((await repo.getAsk(ask.askId))?.answer).toBe("テストも書いて");
    expect((await repo.getSession("KANATA-1234123412341234"))?.status).toBe("running");
    expect((await repo.listRecentSessions(10)).length).toBe(1);
    expect(seen).toEqual(["https://discord.com/api/v10/channels/th-live/messages/msg-live"]);
  });

  it("待っている質問が無ければ、新しいセッションを起動する", async () => {
    replies.set("https://discord.com/api/v10/webhooks/app-1/itok/messages/@original", {
      status: 200,
      body: { id: "msg-new", channel_id: "th-new" },
    });
    replies.set("https://api.anthropic.com/v1/claude_code/routines/trig_test/fire", {
      status: 200,
      body: {
        claude_code_session_id: "session_x",
        claude_code_session_url: "https://claude.ai/code/session_x",
      },
    });
    replies.set("https://discord.com/api/v10/channels/th-new/messages", {
      status: 200,
      body: { id: "msg-note" },
    });

    const response = await handleInteraction(command("はじめて", "th-new"), env, ctx);
    expect(((await response.json()) as { type: number }).type).toBe(5); // 先に «受け付けました»
    await settle();

    const sessions = await new Repo(env.DB).listRecentSessions(10);
    const created = sessions.find((s) => s.prompt === "はじめて");
    expect(created?.status).toBe("running");
    expect(created?.ccSessionUrl).toBe("https://claude.ai/code/session_x");
    expect(seen).toContain("https://api.anthropic.com/v1/claude_code/routines/trig_test/fire");
  });

  it("持ち主以外は何もできず、自分の ID を返してもらえる", async () => {
    const response = await handleInteraction(command("なにか", "th-x", "someone-else"), env, ctx);
    const body = (await response.json()) as { data: { content: string; flags: number } };
    expect(body.data.content).toContain("someone-else");
    expect(body.data.flags).toBe(64); // 本人にしか見えない
  });
});
