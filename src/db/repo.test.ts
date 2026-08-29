import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "./repo";

/**
 * 台帳のうち **順序を間違えると黙ってデータが消える** ところだけを固める。
 *
 * 預かった文の受け渡しは «読む → 渡す → 印を立てる» の 3 手で、印を先に立てると
 * 渡す側が失敗したときに文がどこにも残らない。ここはその «印は後» を構造で守る。
 */

async function seed(sessionKey: string): Promise<Repo> {
  const repo = new Repo(env.DB);
  await repo.createSession({
    sessionKey,
    project: "demo",
    prompt: "テスト",
    requesterId: "owner-1",
    channelId: "ch-1",
  });
  return repo;
}

async function queue(repo: Repo, sessionKey: string, body: string): Promise<void> {
  await repo.queueMessage({
    sessionKey,
    threadId: "th-1",
    authorId: "owner-1",
    messageId: null,
    body,
  });
}

describe("預かった文の受け渡し", () => {
  it("読んだだけでは印が立たない (渡せなかった文が消えない)", async () => {
    const key = "KANATA-aaaa0000aaaa0000";
    const repo = await seed(key);
    await queue(repo, key, "あとで直して");

    const first = await repo.peekQueued(key);
    expect(first?.text).toBe("あとで直して");

    // 渡すのに失敗した、という想定。もう一度読めば同じものが残っている。
    expect((await repo.peekQueued(key))?.text).toBe("あとで直して");
  });

  it("印を立てた後はもう出てこない", async () => {
    const key = "KANATA-bbbb0000bbbb0000";
    const repo = await seed(key);
    await queue(repo, key, "A して");

    const batch = await repo.peekQueued(key);
    if (!batch) throw new Error("預かった文が読めていません");
    await repo.markQueuedTaken(batch.ids);

    expect(await repo.peekQueued(key)).toBeNull();
  });

  it("**印は読んだ行にだけ立てる** (読んだ後に届いた分を巻き込まない)", async () => {
    const key = "KANATA-cccc0000cccc0000";
    const repo = await seed(key);
    await queue(repo, key, "A して");

    const batch = await repo.peekQueued(key);
    if (!batch) throw new Error("預かった文が読めていません");

    // 渡している最中に 2 通目が届いた。これは «次の問い» に回るべきで、
    // «未処理を全部» で印を立てると、渡していないのに渡した扱いになって消える。
    await queue(repo, key, "あと B も");
    await repo.markQueuedTaken(batch.ids);

    expect((await repo.peekQueued(key))?.text).toBe("あと B も");
  });

  it("書いた順に 1 つへ畳む (Claude が聞きに来るのは 1 回だから)", async () => {
    const key = "KANATA-dddd0000dddd0000";
    const repo = await seed(key);
    await queue(repo, key, "まず A");
    await queue(repo, key, "あと B も");

    expect((await repo.peekQueued(key))?.text).toBe("まず A\nあと B も");
  });
});

describe("起動しそこねたセッション", () => {
  it("古い queued だけを拾う (走り出したものと、まだ間に合うものは触らない)", async () => {
    const repo = new Repo(env.DB);
    const old = "KANATA-eeee0000eeee0000";
    const fresh = "KANATA-ffff0000ffff0000";
    const running = "KANATA-eeee1111eeee1111";
    for (const key of [old, fresh, running]) await seed(key);
    await repo.setStatus(running, "running");

    // 台帳の created_at は «今» なので、境界は «未来» と «過去» で作る。
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    const stuck = (await repo.listStuckQueued(future, 10)).map((s) => s.sessionKey);
    expect(stuck).toContain(old);
    expect(stuck).toContain(fresh);
    expect(stuck).not.toContain(running);

    expect(await repo.listStuckQueued(past, 10)).toEqual([]);
  });
});

describe("台帳に入れる値", () => {
  it("hook がまだ来ていないセッションのコンテキスト時刻は空 (返り値が DB と食い違わない)", async () => {
    const key = "KANATA-1111000011110000";
    const repo = new Repo(env.DB);
    const created = await repo.createSession({
      sessionKey: key,
      project: "demo",
      prompt: "テスト",
      requesterId: "owner-1",
      channelId: "ch-1",
    });
    expect(created.contextAt).toBeNull();
    expect((await repo.getSession(key))?.contextAt).toBeNull();
  });
});
