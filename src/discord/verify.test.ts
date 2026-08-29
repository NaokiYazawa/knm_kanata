import { describe, expect, it } from "vitest";
import { timingSafeEqual, verifyDiscordSignature } from "./verify";

/**
 * WebCrypto のアルゴリズム名は runtime ごとに揺れた歴史がある ("NODE-ED25519" 時代)。
 * 本物の鍵で往復させて、**この runtime で "Ed25519" が通ること**まで固める。
 */

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function keyPair(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // exportKey は "raw" でも ArrayBuffer | JsonWebKey に型が付く。
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { publicKeyHex: toHex(raw), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(message),
  );
  return toHex(signature);
}

describe("Discord の署名検証", () => {
  it("正しい署名を通す", async () => {
    const { publicKeyHex, privateKey } = await keyPair();
    const timestamp = "1700000000";
    const rawBody = '{"type":1}';
    const signatureHex = await sign(privateKey, timestamp + rawBody);

    expect(await verifyDiscordSignature({ publicKeyHex, signatureHex, timestamp, rawBody })).toBe(
      true,
    );
  });

  it("本文を 1 文字でも差し替えたら落とす", async () => {
    const { publicKeyHex, privateKey } = await keyPair();
    const timestamp = "1700000000";
    const signatureHex = await sign(privateKey, `${timestamp}{"type":1}`);

    expect(
      await verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody: '{"type":2}',
      }),
    ).toBe(false);
  });

  it("timestamp を差し替えたら落とす (リプレイ)", async () => {
    const { publicKeyHex, privateKey } = await keyPair();
    const rawBody = '{"type":1}';
    const signatureHex = await sign(privateKey, `1700000000${rawBody}`);

    expect(
      await verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp: "1700000001",
        rawBody,
      }),
    ).toBe(false);
  });

  it("鍵や署名が壊れていても例外にせず落とす (検証できない = 通さない)", async () => {
    const cases = [
      { publicKeyHex: "zz", signatureHex: "00", timestamp: "1", rawBody: "{}" },
      { publicKeyHex: "00", signatureHex: null, timestamp: "1", rawBody: "{}" },
      { publicKeyHex: "00", signatureHex: "00", timestamp: null, rawBody: "{}" },
      { publicKeyHex: "", signatureHex: "00", timestamp: "1", rawBody: "{}" },
    ];
    for (const input of cases) {
      expect(await verifyDiscordSignature(input)).toBe(false);
    }
  });
});

describe("timingSafeEqual", () => {
  it("一致・不一致・長さ違いを正しく判定する", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
