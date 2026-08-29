import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../db/repo";
import { decideInbound, LIVE_ASK_MS, LIVE_WORK_MS } from "./inbound";

/**
 * «スレッドに書いた 1 文をどう扱うか» の判定。**外し方の代償が非対称**なのが肝で、
 * 溜めすぎて外すと «届かない» (取り返せる)、起こしすぎて外すと «同じスレッドに 2 つ目が立つ»
 * (取り返せない)。テストはその両側を固める。
 */

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function ask(
  overrides: {
    status?: SessionStatus;
    updatedAt?: string;
    hasOpenAsk?: boolean;
    authorId?: string;
    authorIsBot?: boolean;
    text?: string;
    session?: null;
  } = {},
) {
  const session =
    overrides.session === null
      ? null
      : {
          status: overrides.status ?? "running",
          updatedAt: overrides.updatedAt ?? ago(1_000),
        };
  return decideInbound({
    authorId: overrides.authorId ?? "owner-1",
    authorIsBot: overrides.authorIsBot ?? false,
    text: overrides.text ?? "この後 README も直して",
    ownerId: "owner-1",
    session,
    hasOpenAsk: overrides.hasOpenAsk ?? false,
    now: NOW,
  });
}

describe("拾わないもの", () => {
  it("bot の発言は拾わない (自分の質問文が入力として返ってくる)", () => {
    expect(ask({ authorIsBot: true })).toEqual({ kind: "ignore", reason: "bot の発言" });
  });

  it("所有者以外は拾わない (個人用なので allowlist は 1 件)", () => {
    expect(ask({ authorId: "someone-else" }).kind).toBe("ignore");
  });

  it("空白だけの発言は拾わない", () => {
    expect(ask({ text: "  \n " }).kind).toBe("ignore");
  });

  it("kanata が知らないスレッド (= 親チャンネルの雑談) は拾わない", () => {
    // 起動は `/claude` だけ。チャンネルの発言がそのまま Claude へ流れる事故を作らない。
    expect(ask({ session: null })).toEqual({
      kind: "ignore",
      reason: "このスレッドにセッションが無い",
    });
  });
});

describe("待っている質問があるとき", () => {
  it("回答として渡す", () => {
    expect(ask({ status: "waiting", hasOpenAsk: true, updatedAt: ago(30_000) })).toEqual({
      kind: "answer",
    });
  });

  it("印が止まっていれば «落ちている» とみなして起こし直す", () => {
    // 握りは 15 秒ごとに印を更新する。止まっているなら答えを受け取る相手がもう居ない。
    // ここを見ないと、そのスレッドの発言を永久に飲み込む «穴» になる。
    expect(ask({ status: "waiting", hasOpenAsk: true, updatedAt: ago(LIVE_ASK_MS + 1) })).toEqual({
      kind: "restart",
    });
  });

  it("status が running のままでも、質問が出ている以上は印だけで判定する", () => {
    // 質問を出している間の Claude は必ず握って待っている (作業中ではありえない)。
    // status で分けると «running のまま落ちた» を溜め込み続けて、永久に届かなくなる。
    expect(ask({ status: "running", hasOpenAsk: true, updatedAt: ago(LIVE_ASK_MS + 1) })).toEqual({
      kind: "restart",
    });
  });
});

describe("作業中のとき", () => {
  it("溜める (次に聞きに来たとき渡す)", () => {
    expect(ask({ status: "running", updatedAt: ago(20 * 60_000) })).toEqual({ kind: "queue" });
  });

  it("起動直後 (queued) も溜める", () => {
    expect(ask({ status: "queued" })).toEqual({ kind: "queue" });
  });

  it("作業中の窓は握りの窓よりずっと長い", () => {
    // 20 分黙って実装している最中の 1 行で 2 つ目のセッションが立ってはいけない。
    expect(LIVE_WORK_MS).toBeGreaterThan(LIVE_ASK_MS * 100);
    expect(ask({ status: "running", updatedAt: ago(LIVE_WORK_MS - 60_000) }).kind).toBe("queue");
  });

  it("その窓すら越えたら起こし直す (status が running のまま落ちている)", () => {
    expect(ask({ status: "running", updatedAt: ago(LIVE_WORK_MS + 1) })).toEqual({
      kind: "restart",
    });
  });
});

describe("終わっているとき", () => {
  it("done なら新しく起こす", () => {
    expect(ask({ status: "done" })).toEqual({ kind: "restart" });
  });

  it("failed なら新しく起こす", () => {
    expect(ask({ status: "failed" })).toEqual({ kind: "restart" });
  });

  it("印が読めない値なら «古い» に倒す", () => {
    // 新しいと誤ると、落ちたセッションへ渡し続けることになる。
    expect(ask({ status: "running", updatedAt: "こわれている" })).toEqual({ kind: "restart" });
  });
});
