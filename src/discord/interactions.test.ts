import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db/repo";
import { handleInteraction } from "./interactions";

/**
 * `/claude` は 2 つの意味を持つ:
 *
 * - kanata が **知らない** チャンネル / スレッド → 新しいセッションの **起動**
 * - kanata が **知っている** スレッド → 素の文とまったく同じ扱い (回答 / 溜める / 起こし直す)
 *
 * 後者を `discord/inbound.ts` に寄せてあるのが肝で、**同じスレッドに同じ文を書いたのに
 * コマンドか素の文かで結果が変わってはいけない**。ここではその «同じ口へ入っているか» を見る。
 */

let seen: string[] = [];
let replies: Map<string, { status: number; body: unknown }>;
let pending: Promise<unknown>[] = [];

const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

const ORIGINAL = "https://discord.com/api/v10/webhooks/app-1/itok/messages/@original";
const FIRE = "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire";

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

function firedOk(): void {
  replies.set(FIRE, {
    status: 200,
    body: {
      claude_code_session_id: "session_x",
      claude_code_session_url: "https://claude.ai/code/session_x",
    },
  });
}

describe("/claude", () => {
  it("待っている質問があれば、新規起動せず «回答» として渡す", async () => {
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

    // 本人の発言としての echo と、質問メッセージを «回答済み» の姿へ差し替える PATCH。
    replies.set(ORIGINAL, { status: 200, body: { id: "msg-echo", channel_id: "th-live" } });
    replies.set("https://discord.com/api/v10/channels/th-live/messages/msg-live", {
      status: 200,
      body: { id: "msg-live" },
    });

    // 3 秒に収まらないので «受け付けました» を先に返す。
    const response = await handleInteraction(command("テストも書いて", "th-live"), env, ctx);
    expect(((await response.json()) as { type: number }).type).toBe(5);

    await settle();

    // 回答として入り、セッションは走行中へ戻り、**新しいセッションは作られていない**。
    expect((await repo.getAsk(ask.askId))?.answer).toBe("テストも書いて");
    expect((await repo.getSession("KANATA-1234123412341234"))?.status).toBe("running");
    expect((await repo.listRecentSessions(10)).length).toBe(1);
    expect(seen).not.toContain(FIRE);
  });

  it("kanata が知らないスレッドなら、新しいセッションを起動する", async () => {
    replies.set(ORIGINAL, { status: 200, body: { id: "msg-new", channel_id: "th-new" } });
    firedOk();
    replies.set("https://discord.com/api/v10/channels/th-new/messages", {
      status: 200,
      body: { id: "msg-note" },
    });

    const response = await handleInteraction(command("はじめて", "th-new"), env, ctx);
    expect(((await response.json()) as { type: number }).type).toBe(5); // 先に «受け付けました»
    await settle();

    const created = (await new Repo(env.DB).listRecentSessions(10)).find(
      (s) => s.prompt === "はじめて",
    );
    expect(created?.status).toBe("running");
    expect(created?.ccSessionUrl).toBe("https://claude.ai/code/session_x");
    expect(seen).toContain(FIRE);
  });

  it("死んだセッションの未回答の質問は «回答» にせず、同じスレッドで起こし直す", async () => {
    const repo = new Repo(env.DB);
    await repo.createSession({
      sessionKey: "KANATA-deaddeaddeaddead",
      project: "demo",
      prompt: "落ちた指示",
      requesterId: "owner-1",
      channelId: "ch-1",
    });
    await repo.attachThread("KANATA-deaddeaddeaddead", "th-dead");
    await repo.createAsk({
      askId: "ask_0000000000000dead",
      sessionKey: "KANATA-deaddeaddeaddead",
      question: "もう誰も待っていない質問",
      options: [],
      allowFreeText: true,
    });
    // 生存の印を «十分に古い» ところへ倒す (握りが止まった状態)。
    await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?")
      .bind(new Date(Date.now() - 60 * 60_000).toISOString(), "KANATA-deaddeaddeaddead")
      .run();

    replies.set(ORIGINAL, { status: 200, body: { id: "msg-d", channel_id: "th-dead" } });
    firedOk();
    replies.set("https://discord.com/api/v10/channels/th-dead/messages", {
      status: 200,
      body: { id: "msg-dn" },
    });

    const response = await handleInteraction(command("これは新しい話", "th-dead"), env, ctx);
    expect(((await response.json()) as { type: number }).type).toBe(5);
    await settle();

    // 古い質問には答えず、同じスレッドの中で 2 本目が立つ。
    expect((await repo.getAsk("ask_0000000000000dead"))?.answer).toBeNull();
    expect(seen).toContain(FIRE);
    const started = (await repo.listRecentSessions(10)).find((s) => s.prompt === "これは新しい話");
    expect(started?.threadId).toBe("th-dead");
  });

  it("作業中のスレッドでは起動せず、預かる", async () => {
    const repo = new Repo(env.DB);
    await repo.createSession({
      sessionKey: "KANATA-0f0f0f0f0f0f0f0f",
      project: "demo",
      prompt: "実装中",
      requesterId: "owner-1",
      channelId: "ch-1",
    });
    await repo.attachThread("KANATA-0f0f0f0f0f0f0f0f", "th-busy");
    await repo.setStatus("KANATA-0f0f0f0f0f0f0f0f", "running");

    replies.set(ORIGINAL, { status: 200, body: { id: "msg-b", channel_id: "th-busy" } });

    await handleInteraction(command("この後 README も", "th-busy"), env, ctx);
    await settle();

    // 起動しない。次に Claude が聞きに来たときに渡す。
    expect(seen).not.toContain(FIRE);
    expect((await repo.listRecentSessions(10)).length).toBe(1);
    expect(await repo.takeQueued("KANATA-0f0f0f0f0f0f0f0f")).toMatchObject({
      text: "この後 README も",
      authorId: "owner-1",
    });
  });

  it("持ち主以外は何もできず、自分の ID を返してもらえる", async () => {
    const response = await handleInteraction(command("なにか", "th-x", "someone-else"), env, ctx);
    const body = (await response.json()) as { data: { content: string; flags: number } };
    expect(body.data.content).toContain("someone-else");
    expect(body.data.flags).toBe(64); // 本人にしか見えない
  });
});
