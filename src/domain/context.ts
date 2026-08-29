/**
 * コンテキスト使用量の計算と描画。**純粋**。
 *
 * ## どこから来る数字か
 *
 * Claude Code は hook にトークン数を渡さない (どのイベントの入力にも入っていない)。
 * ステータスラインは持っているが、あれは対話 UI 専用でクラウドセッションでは動かない。
 * 残る唯一の出口が **転写ログ (`transcript_path`) の `message.usage`** で、hook がそれを
 * 読んで送ってくる (`repo-template/.claude/hooks/kanata-hook.sh`)。
 *
 * ## 何を分母にするか
 *
 * 公式のステータスラインと同じ式にそろえる:
 *
 * > `used_percentage` は **input 側だけ**から計算する:
 * > `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。
 * > `output_tokens` は含めない。
 *
 * 分母 (`context_window_size`) は 200,000 が既定で、拡張コンテキストのモデルは 1,000,000。
 * **転写ログからは分母が読めない**ので設定で持つ (`CONTEXT_WINDOW_TOKENS`)。ズレても
 * 生のトークン数を併記するので、読み手が真値を見失うことはない。
 *
 * ## 1 つ古いことがある
 *
 * 転写ログは非同期に書かれるので、hook が走った時点で最新のメッセージがまだ載っていない
 * ことがある (公式ドキュメントに明記)。だから表示は **「直前のやりとりまでの値」** で、
 * 厳密な現在値ではない。桁を見るには十分だが、そう思って読む。
 */

/** 既定の分母。拡張コンテキストのモデルなら 1,000,000。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** バーの目盛り。Discord の subtext でも潰れない幅。 */
const BAR_CELLS = 20;
const BAR_FILLED = "▓";
const BAR_EMPTY = "░";

export type ContextUsage = Readonly<{
  /** input 側の合計 (cache 読み書きを含む)。これが分子。 */
  usedTokens: number;
  /** 直近の応答の出力トークン。表示には使わないが記録として持つ。 */
  outputTokens: number;
}>;

export type ContextProblem = Readonly<{ message: string }>;

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * hook が送ってきた生の usage を検証して合計する。
 *
 * 4 つのうち **1 つでも読めなければ断る**。欠けたまま足すと «急に減った» ように見え、
 * 「まだ余裕がある」と誤読させる — 出さない方がまだ安全。
 */
export function totalContextUsage(body: {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}): ContextUsage | ContextProblem {
  const input = nonNegative(body.input_tokens);
  const cacheCreation = nonNegative(body.cache_creation_input_tokens);
  const cacheRead = nonNegative(body.cache_read_input_tokens);
  const output = nonNegative(body.output_tokens);
  if (input === null || cacheCreation === null || cacheRead === null || output === null) {
    return { message: "input / cache_creation / cache_read / output のどれかが数値ではありません" };
  }
  return { usedTokens: input + cacheCreation + cacheRead, outputTokens: output };
}

export function isContextProblem(value: ContextUsage | ContextProblem): value is ContextProblem {
  return "message" in value;
}

export function contextWindowTokens(raw: string | undefined): number {
  const value = Number(raw ?? "");
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_CONTEXT_WINDOW;
}

/** 「124k」。3 桁を超えたら k に畳む (subtext に 6 桁を並べても読めない)。 */
function compact(tokens: number): string {
  return tokens < 1_000 ? `${tokens}` : `${Math.round(tokens / 1_000)}k`;
}

/**
 * Claude の発言の末尾に添える 1 行。**`-#` の subtext で出す** ので、本文より小さく、
 * 会話の邪魔をしない。
 *
 * 使用量が分母を超えることがある (分母の設定が実際のモデルと違うとき)。**バーは 100% で
 * 止めるが、数字は丸めない** — 嘘のバーより、辻褄の合わない数字の方が気付ける。
 */
export function contextLine(usage: ContextUsage | null, windowTokens: number): string | null {
  if (!usage) return null;
  const ratio = usage.usedTokens / windowTokens;
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(ratio * BAR_CELLS)));
  const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_CELLS - filled);
  const percent = Math.round(ratio * 100);
  return `-# ${bar} ${percent}% ・${compact(usage.usedTokens)}/${compact(windowTokens)}`;
}
