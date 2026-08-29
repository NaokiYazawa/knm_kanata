import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db/repo";
import { STUCK_QUEUED_MS, sweepStuckSessions } from "./sweep";

/**
 * `/claude` の続きは `waitUntil` の中で走り、そこは **応答から 30 秒**で切られる。
 * 切られると `queued` の行だけが残り、`domain/inbound.ts` はそれを «起動直後» とみなして
 * 以後の発言を溜め続ける — «書いたのに何も起きない» という、いちばん気付きにくい壊れ方。
 * ここはその掃除が «拾いすぎず・取りこぼさない» ことを見る。
 */

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ id: "msg-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

async function seed(sessionKey: string, threadId: string | null): Promise<Repo> {
  const repo = new Repo(env.DB);
  await repo.createSession({
    sessionKey,
    project: "demo",
    prompt: "テスト",
    requesterId: "owner-1",
    channelId: "ch-1",
  });
  if (threadId) await repo.attachThread(sessionKey, threadId);
  return repo;
}

/** 掃除の «今» をずらして «時間切れ» を作る (時間で待たない)。 */
const laterThanCutoff = Date.now() + STUCK_QUEUED_MS + 60_000;

describe("起動しそこねたセッションの掃除", () => {
  it("時間切れの queued を failed にして、そのスレッドへ知らせる", async () => {
    const key = "KANATA-5555000055550000";
    const repo = await seed(key, "th-sweep");

    expect(await sweepStuckSessions(env, laterThanCutoff)).toBe(1);

    expect((await repo.getSession(key))?.status).toBe("failed");
    expect(calls).toContain("https://discord.com/api/v10/channels/th-sweep/messages");
  });

  it("**起こし直さない** (実は起動できていた場合に 2 本目が立つので、判断は次の 1 行に預ける)", async () => {
    await seed("KANATA-6666000066660000", "th-sweep2");

    await sweepStuckSessions(env, laterThanCutoff);

    // routine を叩いていない。叩く経路は «人が次に何か書いたとき» だけ。
    expect(calls.some((url) => url.includes("api.anthropic.com"))).toBe(false);
  });

  it("まだ間に合うものには触らない", async () => {
    const key = "KANATA-7777000077770000";
    const repo = await seed(key, "th-sweep3");

    expect(await sweepStuckSessions(env, Date.now())).toBe(0);
    expect((await repo.getSession(key))?.status).toBe("queued");
    expect(calls).toEqual([]);
  });

  it("走り出したセッションには触らない", async () => {
    const key = "KANATA-8888000088880000";
    const repo = await seed(key, "th-sweep4");
    await repo.setStatus(key, "running");

    expect(await sweepStuckSessions(env, laterThanCutoff)).toBe(0);
    expect((await repo.getSession(key))?.status).toBe("running");
  });

  it("スレッドが無ければ元のチャンネルへ出す (知らせが消えない)", async () => {
    await seed("KANATA-9999000099990000", null);

    await sweepStuckSessions(env, laterThanCutoff);

    expect(calls).toContain("https://discord.com/api/v10/channels/ch-1/messages");
  });
});
