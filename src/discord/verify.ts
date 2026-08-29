/**
 * Discord の Interactions エンドポイントは **公開 URL** なので、署名検証が唯一の入口ゲート。
 * 失敗は必ず 401 で返す (Discord は 401 を «検証している» と見なして登録を通す)。
 */

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

export async function verifyDiscordSignature(input: {
  publicKeyHex: string;
  signatureHex: string | null;
  timestamp: string | null;
  rawBody: string;
}): Promise<boolean> {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = input;
  if (!signatureHex || !timestamp) return false;

  const publicKey = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex);
  if (!publicKey || !signature) return false;

  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    // 鍵の形が違う / アルゴリズム未対応。検証できない = 通さない (fail-closed)。
    return false;
  }
}

/**
 * MCP・hook・運用の Bearer ゲート。**設定が空なら誰も通さない。**
 *
 * 空文字どうしは «一致» になるので、`KANATA_TOKEN` を入れ忘れた Worker では
 * `Authorization: Bearer ` (値なし) がそのまま通る。公開 URL のゲートで、**設定漏れが
 * 全開になる**形を残さない (`domain/owner.ts` が同じ理由で同じ形をしている)。
 *
 * 前後の空白は落としてから比べる。`echo "…" | wrangler secret put` で末尾に改行が入り、
 * «値は合っているのに弾かれる» が無言で起きるため。
 */
export function bearerOk(header: string | undefined, configured: string | undefined): boolean {
  const expected = (configured ?? "").trim();
  // 設定されていない = 誰も通さない。ここは秘密ではなく設定の状態なので、早期に返してよい。
  if (expected === "") return false;

  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length).trim(), expected);
}

/**
 * 値どうしの照合。長さの差で早期に false を返さないよう、固定長へ均してから比べる。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
