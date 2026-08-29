import { describe, expect, it } from "vitest";
import {
  contextLine,
  contextWindowTokens,
  DEFAULT_CONTEXT_WINDOW,
  isContextProblem,
  totalContextUsage,
} from "./context";

/**
 * 分子の式は公式のステータスラインに合わせてある:
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (**output は含めない**)。
 * ここがズレると、キャッシュを多用したセッションで «まだ 5% しか使っていない» ように見える。
 */

const usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 1_017,
  cache_read_input_tokens: 122_981,
  output_tokens: 476,
};

describe("使用量の合計", () => {
  it("input 側だけを足す (output は分子に入れない)", () => {
    const total = totalContextUsage(usage);
    expect(isContextProblem(total)).toBe(false);
    expect(total).toEqual({ usedTokens: 124_000, outputTokens: 476 });
  });

  it("1 つでも読めなければ断る", () => {
    // 欠けたまま足すと «急に減った» ように見え、「まだ余裕がある」と誤読させる。
    for (const key of [
      "input_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "output_tokens",
    ]) {
      const broken = { ...usage, [key]: null };
      expect(isContextProblem(totalContextUsage(broken))).toBe(true);
    }
    expect(isContextProblem(totalContextUsage({}))).toBe(true);
    expect(isContextProblem(totalContextUsage({ ...usage, input_tokens: -1 }))).toBe(true);
  });
});

describe("分母", () => {
  it("設定が無ければ 200,000", () => {
    expect(contextWindowTokens(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowTokens("")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowTokens("なんだこれ")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowTokens("0")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("拡張コンテキストのモデルには 1,000,000 を渡せる", () => {
    expect(contextWindowTokens("1000000")).toBe(1_000_000);
  });
});

describe("Claude の発言に添える 1 行", () => {
  it("バーと % と生のトークン数を出す", () => {
    const line = contextLine({ usedTokens: 124_000, outputTokens: 476 }, 200_000);
    expect(line).toBe("-# ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 62% ・124k/200k");
    // `-#` の subtext で出す (本文より小さく、会話の邪魔をしない)。
    expect(line?.startsWith("-# ")).toBe(true);
  });

  it("空と満杯を端まで振り切る", () => {
    expect(contextLine({ usedTokens: 0, outputTokens: 0 }, 200_000)).toContain(
      "░░░░░░░░░░░░░░░░░░░░ 0%",
    );
    expect(contextLine({ usedTokens: 200_000, outputTokens: 0 }, 200_000)).toContain(
      "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100%",
    );
  });

  it("分母を超えてもバーは 100% で止め、数字は丸めない", () => {
    // 分母の設定が実際のモデルと違うと起きる (実測: 1M のモデルで 405,336 使っていた)。
    // 嘘のバーより、辻褄の合わない数字の方が気付ける。
    const line = contextLine({ usedTokens: 405_336, outputTokens: 0 }, 200_000);
    expect(line).toBe("-# ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 203% ・405k/200k");
  });

  it("1000 未満は k に畳まない", () => {
    expect(contextLine({ usedTokens: 812, outputTokens: 0 }, 200_000)).toContain("・812/200k");
  });

  it("値が 1 度も来ていなければ何も添えない", () => {
    expect(contextLine(null, 200_000)).toBeNull();
  });
});
