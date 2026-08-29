import type { SessionStatus } from "../db/repo";

/**
 * スレッドに素で書かれた 1 文を「どう扱うか」を決める。**純粋関数**。
 *
 * 走っているセッションへ外から発言を差し込む手段は無い (`CLAUDE.md` §1)。渡せるのは
 * Claude が `ask_human` を呼んで待っている瞬間だけなので、扱いは 4 通りしかない:
 *
 * | 状況 | 扱い |
 * |---|---|
 * | 待っている質問がある | その **回答**として渡す (握りが即座に解ける) |
 * | 作業中 | **溜める**。次に Claude が聞きに来たとき渡す |
 * | 終わっている / 落ちている | 同じスレッドで **新しく起こす** |
 * | 自分たちの会話ではない | **何もしない** |
 *
 * ## «生きている» をどう見るか
 *
 * 印は `sessions.updated_at` ひとつだが、**更新される頻度が状況で違う**ので窓を 2 つ持つ:
 *
 * - 質問を出して握っている間は 15 秒ごとに `touchSession` が走る → 3 分あれば十分内側
 * - 作業中は誰も触らない → 数時間開くことがある
 *
 * 同じ窓で見ると «20 分黙って実装している最中に書いた 1 行» が «落ちている» と判定され、
 * 同じスレッドに 2 つ目のセッションが立つ。逆に長い窓だけで見ると、落ちたセッションの
 * 未回答の質問が以後の発言を永久に飲み込む «穴» になる (`CLAUDE.md` §5.5)。
 */

/** 握っている証拠として認める新しさ。ping は 15 秒ごとなので、生きていれば必ず内側。 */
export const LIVE_ASK_MS = 3 * 60_000;

/**
 * 作業中として認める新しさ。作業中は印が更新されないので長く取る。
 *
 * 外し方の代償が非対称なのでこの向きに倒す — 長すぎて外すと «溜めたまま届かない»
 * (`/claude` で起こし直せる)、短すぎて外すと «同じスレッドに 2 つ目が立つ» (取り返せない)。
 */
export const LIVE_WORK_MS = 6 * 60 * 60_000;

export type InboundDecision =
  | Readonly<{ kind: "ignore"; reason: string }>
  | Readonly<{ kind: "answer" }>
  | Readonly<{ kind: "queue" }>
  | Readonly<{ kind: "restart" }>;

export type InboundContext = Readonly<{
  /** 書いた人。所有者以外は fail-closed で落とす (個人用なので allowlist は 1 件)。 */
  authorId: string;
  authorIsBot: boolean;
  text: string;
  ownerId: string;
  /** そのスレッドの最新セッション。無ければ kanata の会話ではない。 */
  session: Readonly<{ status: SessionStatus; updatedAt: string }> | null;
  /** そのセッションに未回答の質問があるか。 */
  hasOpenAsk: boolean;
  now: number;
}>;

function freshWithin(updatedAt: string, windowMs: number, now: number): boolean {
  const at = new Date(updatedAt).getTime();
  // 読めない値は «古い» に倒す。新しいと誤ると落ちたセッションに渡し続けることになる。
  if (Number.isNaN(at)) return false;
  return now - at <= windowMs;
}

export function decideInbound(ctx: InboundContext): InboundDecision {
  // 自分の投稿もここで落ちる (bot の発言を拾うと ask の質問文が入力として返ってくる)。
  if (ctx.authorIsBot) return { kind: "ignore", reason: "bot の発言" };
  if (ctx.authorId !== ctx.ownerId) return { kind: "ignore", reason: "所有者以外" };
  if (ctx.text.trim() === "") return { kind: "ignore", reason: "本文が空" };

  // スレッド外 (親チャンネル) と、kanata が知らないスレッドはここで落ちる。
  // 起動は `/claude` だけ — 雑談がそのまま Claude へ流れる事故を作らない。
  if (ctx.session === null) return { kind: "ignore", reason: "このスレッドにセッションが無い" };

  const { status, updatedAt } = ctx.session;

  // 質問が出ている間、Claude は必ず握って待っている (作業中ではありえない)。だから
  // **印が止まっていればそれだけで落ちている**と言い切れる。status は見なくてよい。
  // ここを status で分けると、落ちたセッションの未回答の質問が以後の発言を飲み込む。
  if (ctx.hasOpenAsk) {
    return freshWithin(updatedAt, LIVE_ASK_MS, ctx.now) ? { kind: "answer" } : { kind: "restart" };
  }

  if (status === "done" || status === "failed") return { kind: "restart" };
  // 質問が無いのに waiting = 取りこぼし。待っている相手が居ないので起こし直す。
  if (status === "waiting") return { kind: "restart" };
  if (!freshWithin(updatedAt, LIVE_WORK_MS, ctx.now)) return { kind: "restart" };
  return { kind: "queue" };
}
