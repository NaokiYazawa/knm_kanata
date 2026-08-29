import { describe, expect, it } from "vitest";
import { findProject, findProjectByChannel, isProjectsProblem, parseProjects } from "./projects";

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

describe("チャンネルとの結び付け", () => {
  const json = JSON.stringify([
    {
      name: "alpha",
      channelId: "ch-alpha",
      repos: ["NaokiYazawa/api", "NaokiYazawa/web"],
      repoUrl: "https://github.com/NaokiYazawa/api",
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_a/fire",
      fireToken: "sk-ant-oat01-a",
    },
    {
      name: "beta",
      repoUrl: "https://github.com/NaokiYazawa/beta",
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_b/fire",
      fireToken: "sk-ant-oat01-b",
    },
  ]);

  it("channelId と repos を読む", () => {
    const projects = parseProjects(json);
    if (isProjectsProblem(projects)) throw new Error(projects.message);
    expect(projects[0]).toMatchObject({
      name: "alpha",
      channelId: "ch-alpha",
      repos: ["NaokiYazawa/api", "NaokiYazawa/web"],
    });
    // 書かなくても動く (今までの設定をそのまま読める)。
    expect(projects[1]).toMatchObject({ name: "beta", channelId: null, repos: [] });
  });

  it("チャンネルから引ける。スレッドで叩かれたら親チャンネルで当たる", () => {
    const projects = parseProjects(json);
    if (isProjectsProblem(projects)) throw new Error(projects.message);
    // 呼ぶ側は [親チャンネル, そのチャンネル] の順で渡す。
    expect(findProjectByChannel(projects, ["ch-alpha", "th-1"])?.name).toBe("alpha");
    expect(findProjectByChannel(projects, [undefined, "ch-alpha"])?.name).toBe("alpha");
    expect(findProjectByChannel(projects, [undefined, "ch-other"])).toBeNull();
    expect(findProjectByChannel(projects, [null, undefined])).toBeNull();
  });

  it("同じチャンネルに 2 つ結び付けたら設定ごと断る", () => {
    // 静かに片方を選ぶと «なぜ違うプロジェクトが動いたのか» が誰にも分からなくなる。
    const dup = JSON.stringify([
      { name: "a", channelId: "ch-1", repoUrl: "u", fireUrl: "f", fireToken: "t" },
      { name: "b", channelId: "ch-1", repoUrl: "u", fireUrl: "f", fireToken: "t" },
    ]);
    const problem = parseProjects(dup);
    expect(isProjectsProblem(problem)).toBe(true);
    expect((problem as { message: string }).message).toContain("ch-1");
  });

  it("repos が配列でなければ断る", () => {
    const bad = JSON.stringify([
      { name: "a", repos: "api", repoUrl: "u", fireUrl: "f", fireToken: "t" },
    ]);
    expect(isProjectsProblem(parseProjects(bad))).toBe(true);
  });
});
