import { describe, expect, it } from "vitest";
import { newSessionKey, SESSION_KEY_PREFIX } from "./ids";
import { buildFireText, ROUTINE_PROMPT } from "./prompt";

describe("routine へ渡すもの", () => {
  it("fire の 1 行目がそのまま session_key になる", () => {
    const key = newSessionKey();
    expect(buildFireText(key, "なにかして").split("\n")[0]).toBe(key);
  });

  it("routine のプロンプトが印の形を正しく名指ししている", () => {
    // prompt.ts は node から素で走らせるため ids.ts を import できない。
    // «印がズレていない» はここで見る。
    expect(ROUTINE_PROMPT).toContain(SESSION_KEY_PREFIX);
  });

  it("使わせたい道具を全部名指ししている", () => {
    for (const tool of ["ask_human", "ask_wait", "report"]) {
      expect(ROUTINE_PROMPT).toContain(`mcp__kanata__${tool}`);
    }
  });
});
