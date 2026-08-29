import { describe, expect, it } from "vitest";
import { findProject, isProjectsProblem, parseProjects } from "./projects";

const one = JSON.stringify([
  {
    name: "demo",
    repoUrl: "https://github.com/example/demo",
    fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_x/fire",
    fireToken: "sk-ant-oat01-secret",
  },
]);

describe("parseProjects", () => {
  it("読める", () => {
    const parsed = parseProjects(one);
    expect(isProjectsProblem(parsed)).toBe(false);
    if (!isProjectsProblem(parsed)) expect(findProject(parsed, "demo")?.repoUrl).toContain("demo");
  });

  it("未設定・壊れた JSON・空配列を理由つきで弾く", () => {
    for (const raw of [undefined, "{", "[]", "{}"]) {
      expect(isProjectsProblem(parseProjects(raw))).toBe(true);
    }
  });

  it("欠けた項目を弾く", () => {
    const raw = JSON.stringify([{ name: "demo", repoUrl: "https://x" }]);
    expect(isProjectsProblem(parseProjects(raw))).toBe(true);
  });

  it("同じ name が 2 つあると弾く", () => {
    const parsed = parseProjects(`[${one.slice(1, -1)},${one.slice(1, -1)}]`);
    expect(isProjectsProblem(parsed)).toBe(true);
  });

  it("失敗しても秘密そのものはメッセージに載せない", () => {
    const raw = JSON.stringify([{ fireToken: "sk-ant-oat01-secret" }]);
    const parsed = parseProjects(raw);
    expect(isProjectsProblem(parsed)).toBe(true);
    if (isProjectsProblem(parsed)) expect(parsed.message).not.toContain("sk-ant-oat01");
  });
});
