import { describe, expect, it } from "vitest";
import { isOwner } from "./owner";

describe("isOwner", () => {
  it("一致すれば通す", () => {
    expect(isOwner("123", "123")).toBe(true);
  });

  it("設定値に改行や空白が混ざっていても通す (secret を echo で入れた事故)", () => {
    expect(isOwner("123\n", "123")).toBe(true);
    expect(isOwner("  123  ", "123")).toBe(true);
  });

  it("未設定・空欄なら誰も通さない", () => {
    expect(isOwner(undefined, "123")).toBe(false);
    expect(isOwner("", "")).toBe(false);
    expect(isOwner("   ", "123")).toBe(false);
  });

  it("違う人・不明な人は通さない", () => {
    expect(isOwner("123", "456")).toBe(false);
    expect(isOwner("123", null)).toBe(false);
  });
});
