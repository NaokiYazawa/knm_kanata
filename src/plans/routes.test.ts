import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../db/repo";
import worker from "../index";

/**
 * 実装計画の置き場を通しで固める。**入口 (`index.ts`) 越しに叩く** —
 * ゲートとルーティング (`/p/<32hex>/` の形) もここで一緒に守りたいため。
 */

const SESSION = "KANATA-00000000000000aa";
const ORIGIN = "https://kanata.test";

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function put(slug: string, path: string, body: string, sessionKey = SESSION): Request {
  return new Request(`${ORIGIN}/plans/${slug}/${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${env.KANATA_TOKEN}`,
      "x-kanata-session": sessionKey,
      "content-type": "text/markdown",
    },
    body,
  });
}

function finish(slug: string, paths: string[], sessionKey = SESSION): Request {
  return new Request(`${ORIGIN}/plans/${slug}/finish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.KANATA_TOKEN}`,
      "x-kanata-session": sessionKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ paths }),
  });
}

/** `finish` が返す URL からパス部分だけを取る (以後の GET に使う)。 */
async function publish(slug: string, files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    expect((await call(put(slug, path, body))).status).toBe(200);
  }
  const response = await call(finish(slug, Object.keys(files)));
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  return new URL(url).pathname;
}

beforeEach(async () => {
  const repo = new Repo(env.DB);
  await repo.createSession({
    sessionKey: SESSION,
    project: "demo",
    prompt: "計画を書く",
    requesterId: "owner-1",
    channelId: "ch-demo",
  });
  await repo.attachThread(SESSION, "th-1");
});

describe("置く", () => {
  it("Bearer が無ければ 401", async () => {
    const request = new Request(`${ORIGIN}/plans/demo/README.md`, {
      method: "PUT",
      headers: { "x-kanata-session": SESSION },
      body: "# あ",
    });
    expect((await call(request)).status).toBe(401);
  });

  it("知らないセッションからは置かせない", async () => {
    const response = await call(put("demo", "README.md", "# あ", "KANATA-ffffffffffffffff"));
    expect(response.status).toBe(404);
  });

  it("計画の外へ手が伸びるパスを弾く", async () => {
    // 素の `../` は URL の時点で畳まれてしまうので、**割り算されない形 (%2e%2e%2f)** で試す。
    // R2 のキーは `{plan_id}/{path}` で組むので、ここを抜けると他の計画に手が届く。
    expect((await call(put("demo", "%2e%2e%2fother%2fREADME.md", "x"))).status).toBe(400);
    expect((await call(put("demo", "%2e%2e%2f..%2fetc", "x"))).status).toBe(400);
  });

  it("**同じスレッドの同じ名前は同じ URL になる**", async () => {
    // 直して出し直すたびに URL が変わると、スレッドに貼ったリンクが古い方を指し続ける。
    const first = await publish("demo", { "README.md": "# 一度目" });
    const second = await publish("demo", { "README.md": "# 二度目" });
    expect(second).toBe(first);

    const page = await call(new Request(`${ORIGIN}${first}`));
    expect(await page.text()).toContain("二度目");
  });

  it("セッションが変わってもスレッドが同じなら同じ URL", async () => {
    const repo = new Repo(env.DB);
    const restarted = "KANATA-00000000000000bb";
    await repo.createSession({
      sessionKey: restarted,
      project: "demo",
      prompt: "続き",
      requesterId: "owner-1",
      channelId: "ch-demo",
    });
    await repo.attachThread(restarted, "th-1");

    const first = await publish("demo", { "README.md": "# 一度目" });
    for (const [path, body] of Object.entries({ "README.md": "# 起こし直した" })) {
      await call(put("demo", path, body, restarted));
    }
    const response = await call(finish("demo", ["README.md"], restarted));
    const { url } = (await response.json()) as { url: string };
    expect(new URL(url).pathname).toBe(first);
  });

  it("名前を変えて出し直すと、古いファイルが消える", async () => {
    const base = await publish("demo", { "README.md": "# あ", "old.md": "# 古い" });
    expect((await call(new Request(`${ORIGIN}${base}old.md`))).status).toBe(200);

    await publish("demo", { "README.md": "# あ", "new.md": "# 新しい" });
    expect((await call(new Request(`${ORIGIN}${base}old.md`))).status).toBe(404);
    expect((await call(new Request(`${ORIGIN}${base}new.md`))).status).toBe(200);
  });
});

describe("読む", () => {
  it("入口は README.md を描画して返す", async () => {
    const base = await publish("demo", {
      "README.md": "# 設計\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
      "phase-01.md": "# 第 1 段\n",
    });
    const response = await call(new Request(`${ORIGIN}${base}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>設計</title>");
    expect(html).toContain("<table>");
    // 並びから他のファイルへ行ける。
    expect(html).toContain("phase-01.md");
  });

  it("**末尾に / が無ければ付けて飛ばす**", async () => {
    // 無いと計画の中の `./phase-01.md` が `/p/phase-01.md` に解決されて全部 404 になる。
    const base = await publish("demo", { "README.md": "# あ" });
    const response = await call(new Request(`${ORIGIN}${base.replace(/\/$/, "")}`));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(base);
  });

  it("URL を守るヘッダが付いている", async () => {
    const base = await publish("demo", { "README.md": "# あ" });
    const response = await call(new Request(`${ORIGIN}${base}`));
    // 鍵は URL そのものなので、URL が外へ出ていく口を塞ぐ。
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("?raw=1 で原文が取れる", async () => {
    // `plans/` は gitignore なのでワークスペースと一緒に消える。後のセッションが取り戻す口。
    const base = await publish("demo", { "README.md": "# 設計\n" });
    const response = await call(new Request(`${ORIGIN}${base}README.md?raw=1`));
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe("# 設計\n");
  });

  it("**markdown 以外を text/html で返さない**", async () => {
    const base = await publish("demo", { "README.md": "# あ", "evil.html": "<script>x</script>" });
    const response = await call(new Request(`${ORIGIN}${base}evil.html`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // **本体を読み切る。** markdown 以外は R2 のストリームをそのまま返しているので、
    // 読まずに捨てると R2 の接続が開いたままになり、テストの後片付け (isolated storage) が
    // «pop できない» で落ちる。落ち方が本題と無関係なので、ここで理由を書いておく。
    expect(await response.text()).toBe("<script>x</script>");
  });

  it("知らない plan_id は 404", async () => {
    const response = await call(new Request(`${ORIGIN}/p/${"0".repeat(32)}/`));
    expect(response.status).toBe(404);
    // 何が無いのかは書かない (存在の有無を漏らさない)。
    expect(await response.text()).toContain("見つかりません");
  });

  it("plan_id の形をしていないものはルートに乗らない", async () => {
    expect((await call(new Request(`${ORIGIN}/p/short/`))).status).toBe(404);
  });

  it("置いていないファイルは 404", async () => {
    const base = await publish("demo", { "README.md": "# あ" });
    expect((await call(new Request(`${ORIGIN}${base}nope.md`))).status).toBe(404);
  });
});
