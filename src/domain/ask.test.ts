import { describe, expect, it } from "vitest";
import { isAskProblem, MAX_OPTIONS, parseAskAction, pickCustomId, validateAsk } from "./ask";

const base = { sessionKey: "KANATA-0123456789abcdef", question: "どちらにしますか", options: [] };

describe("validateAsk", () => {
  it("選択肢が無くてもよい (スレッドに書けば答えになるので、答える手段は常にある)", () => {
    const result = validateAsk({ ...base, options: [] });
    expect(isAskProblem(result)).toBe(false);
    if (!isAskProblem(result)) expect(result.options).toEqual([]);
  });

  it("選択肢が多すぎるとき、黙って切らずに理由を返す", () => {
    const options = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `案${i}`);
    const result = validateAsk({ ...base, options });
    expect(isAskProblem(result)).toBe(true);
    if (isAskProblem(result)) expect(result.message).toContain("多すぎます");
  });

  it("同じ選択肢が 2 つあると弾く", () => {
    const result = validateAsk({ ...base, options: ["A", "A"] });
    expect(isAskProblem(result)).toBe(true);
  });

  it("ラベル上限 (80 字) を超える選択肢を弾く", () => {
    const result = validateAsk({ ...base, options: ["あ".repeat(81)] });
    expect(isAskProblem(result)).toBe(true);
  });

  it("空の質問を弾く", () => {
    const result = validateAsk({ ...base, question: "   " });
    expect(isAskProblem(result)).toBe(true);
  });
});

describe("custom_id", () => {
  it("押されたボタンから ask と選択肢の位置を復元できる", () => {
    expect(parseAskAction(pickCustomId("ask_00112233aabbccdd", 3))).toEqual({
      kind: "pick",
      askId: "ask_00112233aabbccdd",
      index: 3,
    });
  });

  it("範囲外の位置は受け取らない", () => {
    expect(parseAskAction(`ask:ask_1:${MAX_OPTIONS}`)).toBeNull();
    expect(parseAskAction("ask:ask_1:-1")).toBeNull();
  });

  it("知らない形は null", () => {
    expect(parseAskAction("")).toBeNull();
    expect(parseAskAction("nope:ask_1")).toBeNull();
  });
});
