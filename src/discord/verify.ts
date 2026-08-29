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
 * MCP・hook の Bearer 照合。長さの差で早期に false を返さないよう、固定長へ均してから比べる。
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
