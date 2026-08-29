import { describe, expect, it } from "vitest";
import { newSessionKey, SESSION_KEY_PREFIX } from "./ids";
import { buildFireText, ROUTINE_PROMPT, SERVER_INSTRUCTIONS } from "./prompt";

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

describe("サーバーが名乗る使い方 (initialize の instructions)", () => {
  it("待ちが中断される 3 つの形を全部説明している", () => {
    // ここが欠けると、握りが落ちたときに Claude が «同じ質問を出し直す» か
    // «答えの来ない問いを永久に握り直す» のどちらかをやる。
    for (const phrase of ["pending", "ask_wait", "(再送)", "closed", "superseded"]) {
      expect(SERVER_INSTRUCTIONS).toContain(phrase);
    }
  });

  it("長い文書の出し方を名指ししている", () => {
    // ここが欠けると、Claude は 200KB の計画を «ask_human の question に貼る» か
    // «Discord に 120 通に割って出す» のどちらかをやる。スクリプトの置き場は
    // repo-template/.claude/scripts/publish-plan.sh と対 (CLAUDE.md §4)。
    expect(SERVER_INSTRUCTIONS).toContain(".claude/scripts/publish-plan.sh");
    expect(SERVER_INSTRUCTIONS).toContain("?raw=1");
  });

  it("routine 側の本文と食い違わない (どちらを読んでも同じ手順になる)", () => {
    // ROUTINE_PROMPT は貼り直すまで古いままになりうる。**矛盾させない**ことだけを守る。
    for (const phrase of ["ask_wait", "(再送)"]) {
      expect(ROUTINE_PROMPT).toContain(phrase);
    }
  });
});
