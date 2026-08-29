import { Hono } from "hono";
import { handleInteraction } from "./discord/interactions";
import { bearerOk as bearerMatches, verifyDiscordSignature } from "./discord/verify";
import type { Env } from "./env";
import { gatewayStub } from "./gateway/gateway.do";
import { handleContextHook } from "./hooks/context";
import { handleSessionEndHook } from "./hooks/session-end";
import { handleMcp } from "./mcp/server";
import { handlePlanFinish, handlePlanUpload, handlePlanView } from "./plans/routes";
import { sweepStuckSessions } from "./session/sweep";

/**
 * 入口とゲートだけ。どれも公開 URL なので、**ゲートを通らない要求はハンドラに渡さない**
 * (各ハンドラの中で認証をやり直さない)。
 *
 *  - `/discord/interactions` … Discord の Ed25519 署名
 *  - `/mcp` / `/hooks/*` / `/gateway/*` … cloud session と運用が持つ Bearer (`KANATA_TOKEN`)
 *
 * 素の文 (MESSAGE_CREATE) はここには来ない。HTTP で受け取る手段が Discord に無いので、
 * Durable Object が張った WebSocket から入る (`gateway/gateway.do.ts`)。
 */

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("kanata"));

app.post("/discord/interactions", async (c) => {
  const raw = await c.req.text();
  const verified = await verifyDiscordSignature({
    publicKeyHex: c.env.DISCORD_PUBLIC_KEY,
    signatureHex: c.req.header("x-signature-ed25519") ?? null,
    timestamp: c.req.header("x-signature-timestamp") ?? null,
    rawBody: raw,
  });
  // Discord は «署名が違うのに 200 が返る» エンドポイントを登録させない。401 が正しい。
  if (!verified) return c.text("invalid signature", 401);

  let interaction: unknown;
  try {
    interaction = JSON.parse(raw);
  } catch {
    return c.text("bad json", 400);
  }
  return handleInteraction(interaction as never, c.env, c.executionCtx);
});

function bearerOk(c: { req: { header: (name: string) => string | undefined }; env: Env }): boolean {
  return bearerMatches(c.req.header("authorization"), c.env.KANATA_TOKEN);
}

app.post("/mcp", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handleMcp(c.req.raw, c.env, c.executionCtx);
});

// GET のストリームは持たない (サーバー起点の通知は要らない)。仕様上 405 を返してよい。
// 待ちの SSE は POST の応答として返すので、こちらは使わない。
app.get("/mcp", (c) => c.text("method not allowed", 405));

// hook は 2 つとも «保険» で、落ちても本題は進む (hook 側は必ず exit 0 する)。
app.post("/hooks/session-end", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handleSessionEndHook(c.req.raw, c.env);
});

app.post("/hooks/context", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handleContextHook(c.req.raw, c.env);
});

/**
 * 実装計画の置き場。**置くのは Bearer、読むのは URL そのものが鍵**。
 *
 * 読む側にゲートを掛けないのは利用者判断 (推測不能な URL で十分)。`plan_id` は 128bit で、
 * 総当たりは成立しない。URL が漏れる経路は `plans/routes.ts` のヘッダで塞いである。
 *
 * 本文は MCP ツールではなく素の HTTP で受ける。**ツールの引数に載せると 200KB 超の計画を
 * Claude が丸ごと再出力することになる**ため (`plans/routes.ts` の why)。
 */
app.put("/plans/:slug/:path{.+}", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handlePlanUpload(c.req.raw, c.env, c.req.param("slug"), c.req.param("path"));
});

app.post("/plans/:slug/finish", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handlePlanFinish(c.req.raw, c.env, c.req.param("slug"));
});

// 末尾の `/` を必ず付ける。**無いと計画の中の相対リンク (`./phase-01.md`) が
// `/p/phase-01.md` に解決されて全部 404 になる。**
app.get("/p/:planId{[0-9a-f]{32}}", (c) => c.redirect(`/p/${c.req.param("planId")}/`, 301));

app.get("/p/:planId{[0-9a-f]{32}}/:path{.*}", async (c) =>
  handlePlanView(c.req.raw, c.env, c.req.param("planId"), c.req.param("path")),
);

/**
 * Gateway の様子見と、`fatal` からの復帰。
 *
 * `fatal` (close 4004 / 4014 …) は張り直しても同じ結果になるので自動復帰を作っていない。
 * 設定を直した人がその場で試せる口がここ。無いと «Portal で intent を有効にしたのに
 * 上がってこない» の原因が誰にも分からない。
 */
app.get("/gateway/status", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return gatewayStub(c.env).fetch("https://gateway/status");
});

app.post("/gateway/reset", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return gatewayStub(c.env).fetch("https://gateway/reset", { method: "POST" });
});

export default {
  fetch: app.fetch,

  /**
   * 5 分ごとの watchdog。2 つのことをする。
   *
   * 1. Gateway を張り直す。**DO は自分では起動できない**ので、evict されて alarm ごと
   *    消えた状態から戻す手段がこれしかない (alarm は DO が生きている間の自力復帰用)。
   *    既に繋がっていれば `/ensure` は何もしない。
   * 2. **起動しそこねたセッションを畳む** (`session/sweep.ts`)。`waitUntil` は応答から
   *    30 秒で切られるので、routine の起動が間に合わないと `queued` のまま残り、以後
   *    そのスレッドの発言を静かに飲み込み続ける。
   *
   * 片方が落ちてももう片方は進める (掃除が失敗しても Gateway は張り直したい)。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(gatewayStub(env).fetch("https://gateway/ensure", { method: "POST" }));
    ctx.waitUntil(
      sweepStuckSessions(env).catch((error) => {
        console.warn("[sweep] failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export { DiscordGatewayDO } from "./gateway/gateway.do";
