import { Hono } from "hono";
import { handleInteraction } from "./discord/interactions";
import { timingSafeEqual, verifyDiscordSignature } from "./discord/verify";
import type { Env } from "./env";
import { handleStopHook } from "./hooks/stop";
import { handleMcp } from "./mcp/server";

/**
 * 入口は 3 つだけで、それぞれ別のゲートを持つ:
 *
 *  - `/discord/interactions` … Discord の Ed25519 署名
 *  - `/mcp` / `/hooks/*`     … cloud session が持つ Bearer (`KANATA_TOKEN`)
 *
 * どれも公開 URL なので、**ゲートを通らない要求はハンドラに渡さない** (各ハンドラの中で
 * 認証をやり直さない)。
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
  const header = c.req.header("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), c.env.KANATA_TOKEN);
}

app.post("/mcp", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handleMcp(c.req.raw, c.env);
});

// SSE 側のストリームは持たない。仕様上 405 を返してよい (クライアントは POST だけで動く)。
app.get("/mcp", (c) => c.text("method not allowed", 405));

app.post("/hooks/stop", async (c) => {
  if (!bearerOk(c)) return c.text("unauthorized", 401);
  return handleStopHook(c.req.raw, c.env);
});

export default app;
