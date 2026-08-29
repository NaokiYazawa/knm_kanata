import { describe, expect, it } from "vitest";
import {
  backoffMs,
  GATEWAY_INTENTS,
  GATEWAY_URL,
  type GatewayAction,
  type GatewayPayload,
  type GatewayState,
  gatewayConnectUrl,
  gatewayIsHealthy,
  initialGatewayState,
  nextAlarmAt,
  parseGatewayPayload,
  pruneReconnects,
  step,
  throttleReconnect,
} from "./gateway";

/**
 * Gateway の壊れ方は本番でしか出ない (ゾンビ接続・op 9 の d:false・close 4014)。
 * ここで入力を手で作れば全部踏める。**踏めない経路を残さないことが、この層を切った理由**。
 */

function payload(op: number, extra: Partial<GatewayPayload> = {}): GatewayPayload {
  return { op, d: null, s: null, t: null, ...extra };
}

/** HELLO を受けて heartbeat を回している状態まで進める。 */
function live(overrides: Partial<Extract<GatewayState, { kind: "live" }>> = {}): GatewayState {
  return {
    kind: "live",
    intervalMs: 41_250,
    awaitingAck: false,
    ready: true,
    resume: { sessionId: "sess-1", resumeUrl: "wss://resume.discord.gg", seq: 7 },
    ...overrides,
  };
}

function kinds(actions: readonly GatewayAction[]): string[] {
  return actions.map((a) => a.kind);
}

describe("payload の読み取り", () => {
  it("op が無いものは読まない", () => {
    expect(parseGatewayPayload({ d: {} })).toBeNull();
    expect(parseGatewayPayload("hello")).toBeNull();
    expect(parseGatewayPayload(null)).toBeNull();
  });

  it("知らないフィールドは黙って捨てる (Discord は将来増やす)", () => {
    expect(parseGatewayPayload({ op: 0, t: "X", s: 3, d: { a: 1 }, future: true })).toEqual({
      op: 0,
      t: "X",
      s: 3,
      d: { a: 1 },
    });
  });
});

describe("接続の立ち上がり", () => {
  it("HELLO で identify し、最初の heartbeat を散らす", () => {
    const [next, actions] = step(initialGatewayState, {
      kind: "received",
      payload: payload(10, { d: { heartbeat_interval: 41_250 } }),
      jitter: 0.5,
    });
    expect(next.kind).toBe("live");
    expect(kinds(actions)).toEqual(["identify", "schedule_heartbeat"]);
    const scheduled = actions[1];
    // 全員が同時に打たないよう、初回だけ interval を jitter で割る (Discord の指示)。
    expect(scheduled?.kind === "schedule_heartbeat" && scheduled.delayMs).toBe(20_625);
  });

  it("再開できる印が残っていれば identify ではなく resume を送る", () => {
    const state: GatewayState = {
      kind: "connecting",
      attempt: 1,
      resume: { sessionId: "sess-1", resumeUrl: "wss://resume.discord.gg", seq: 42 },
    };
    const [, actions] = step(state, {
      kind: "received",
      payload: payload(10, { d: { heartbeat_interval: 41_250 } }),
      jitter: 0,
    });
    expect(actions[0]).toEqual({ kind: "resume", sessionId: "sess-1", seq: 42 });
  });

  it("READY で再開の印を持ち、healthy になる", () => {
    const [next] = step(live({ ready: false, resume: null }), {
      kind: "received",
      payload: payload(0, {
        t: "READY",
        s: 1,
        d: { session_id: "sess-9", resume_gateway_url: "wss://r.discord.gg" },
      }),
      jitter: 0,
    });
    expect(gatewayIsHealthy(next)).toBe(true);
    expect(next.kind === "live" && next.resume).toEqual({
      sessionId: "sess-9",
      resumeUrl: "wss://r.discord.gg",
      seq: 1,
    });
  });

  it("繋ぎ先は «再開できるか» で変わり、必ず https:// で渡す", () => {
    // Workers の fetch は wss:// を受け取らない (`Fetch API cannot load: wss://…`)。
    // ソケットが開かないだけなので、外すと «原因不明で繋がらない» になる。実際に踏んだ。
    expect(GATEWAY_URL.startsWith("wss://")).toBe(true);
    expect(gatewayConnectUrl(initialGatewayState)).toBe(
      "https://gateway.discord.gg/?v=10&encoding=json",
    );
    // resume_gateway_url も wss:// で来る。
    expect(gatewayConnectUrl(live())).toBe("https://resume.discord.gg?v=10&encoding=json");
  });

  it("要求する intent は GUILD_MESSAGES と MESSAGE_CONTENT の 2 つだけ", () => {
    // 増やすと «関係の無い個人情報が常時流れてくる» ので、値ごと固定する。
    expect(GATEWAY_INTENTS).toBe((1 << 9) | (1 << 15));
  });
});

describe("heartbeat", () => {
  it("打った後は ACK 待ちになり、次の予約を張る", () => {
    const [next, actions] = step(live(), { kind: "heartbeat_due" });
    expect(next.kind === "live" && next.awaitingAck).toBe(true);
    expect(actions[0]).toEqual({ kind: "heartbeat", seq: 7 });
    expect(kinds(actions)).toEqual(["heartbeat", "schedule_heartbeat"]);
  });

  it("ACK が返れば待ちが解ける", () => {
    const [next] = step(live({ awaitingAck: true }), {
      kind: "received",
      payload: payload(11),
      jitter: 0,
    });
    expect(next.kind === "live" && next.awaitingAck).toBe(false);
  });

  it("ACK が返らないまま次が来たら、ゾンビとみなして張り直す", () => {
    // これを見ないと «送っているのに何も届かない» が無言で続く。
    const [, actions] = step(live({ awaitingAck: true }), { kind: "heartbeat_due" });
    expect(actions).toEqual([
      { kind: "close", code: 4000 },
      { kind: "reconnect", delayMs: 0 },
    ]);
  });

  it("サーバーからの催促 (op 1) には即座に打ち返す", () => {
    const [, actions] = step(live(), { kind: "received", payload: payload(1), jitter: 0 });
    expect(actions).toEqual([{ kind: "heartbeat", seq: 7 }]);
  });
});

describe("切断と再開", () => {
  it("op 7 は resume 可能なまま張り直す", () => {
    const [next, actions] = step(live(), { kind: "received", payload: payload(7), jitter: 0 });
    expect(next.kind === "disconnected" && next.resume?.sessionId).toBe("sess-1");
    expect(kinds(actions)).toEqual(["close", "reconnect"]);
  });

  it("op 9 は d の真偽で «印を残すか» が変わる", () => {
    const [keep] = step(live(), { kind: "received", payload: payload(9, { d: true }), jitter: 0 });
    expect(keep.kind === "disconnected" && keep.resume).not.toBeNull();

    const [drop] = step(live(), { kind: "received", payload: payload(9, { d: false }), jitter: 0 });
    expect(drop.kind === "disconnected" && drop.resume).toBeNull();
  });

  it("4009 / 4007 は再開できないので印を捨てる", () => {
    const [next] = step(live(), { kind: "closed", code: 4009, jitter: 0 });
    expect(next.kind === "disconnected" && next.resume).toBeNull();
  });

  it("普通の切断は印を残して backoff する", () => {
    const [next, actions] = step(live(), { kind: "closed", code: 1006, jitter: 1 });
    expect(next.kind === "disconnected" && next.resume?.seq).toBe(7);
    expect(kinds(actions)).toEqual(["reconnect"]);
  });

  it("backoff は倍々で伸び、5 分で止まる", () => {
    expect(backoffMs(0, 1)).toBe(1_000);
    expect(backoffMs(3, 1)).toBe(8_000);
    expect(backoffMs(99, 1)).toBe(300_000);
    // 揺らぎで «同じ瞬間に何度も張り直す» を避ける。
    expect(backoffMs(3, 0)).toBe(4_000);
  });

  it("短時間に張り直しすぎたら 60 秒待たせる (identify のレート制限)", () => {
    const now = 1_000_000;
    const recent = [now - 1, now - 2, now - 3, now - 4, now - 5];
    expect(throttleReconnect(1_000, recent, now)).toBe(60_000);
    expect(throttleReconnect(1_000, recent.slice(0, 2), now)).toBe(1_000);
    // 窓の外は数えない。
    expect(pruneReconnects([now - 120_000, now - 10], now)).toEqual([now - 10]);
  });
});

describe("次の alarm をいつ張るか", () => {
  const live: GatewayState = {
    kind: "live",
    intervalMs: 41_250,
    awaitingAck: false,
    ready: true,
    resume: null,
  };

  it("live なら heartbeat の予約に合わせる", () => {
    expect(nextAlarmAt(live, { heartbeatAt: 1_500, connectAt: null }, 1_000, 60_000)).toBe(1_500);
  });

  it("**張り直した直後 (connecting) は heartbeat の予約を見ない**", () => {
    // evict されると前の接続の予約が «過去の時刻» のまま storage に残る。それを拾うと
    // 即座に alarm が鳴り、HELLO が届く前に «connecting のまま = 死んでいる» と判定して
    // 張ったばかりの接続を自分で殺す。1 周期 (idleMs) 待ってから見に行くのが正しい。
    const connecting: GatewayState = { kind: "connecting", attempt: 0, resume: null };
    expect(nextAlarmAt(connecting, { heartbeatAt: 500, connectAt: null }, 1_000, 60_000)).toBe(
      61_000,
    );
  });

  it("張り直しの予約は状態によらず効く (backoff を追い抜かない)", () => {
    const off: GatewayState = { kind: "disconnected", attempt: 3, resume: null };
    expect(nextAlarmAt(off, { heartbeatAt: 500, connectAt: 9_000 }, 1_000, 60_000)).toBe(9_000);
  });

  it("予約が過去でも今より前には張らない", () => {
    expect(nextAlarmAt(live, { heartbeatAt: 10, connectAt: null }, 5_000, 60_000)).toBe(5_000);
  });

  it("fatal では張らない (待っても変わらない状態で DO を起こし続けない)", () => {
    const dead: GatewayState = { kind: "fatal", reason: "token が違います" };
    expect(nextAlarmAt(dead, { heartbeatAt: 1, connectAt: 1 }, 1_000, 60_000)).toBeNull();
  });
});

describe("直らない失敗", () => {
  it("4014 は «Portal で intent を有効にしていない» と名指しで言う", () => {
    const [next] = step(live(), { kind: "closed", code: 4014, jitter: 0 });
    expect(next.kind).toBe("fatal");
    expect(next.kind === "fatal" && next.reason).toContain("MESSAGE CONTENT INTENT");
  });

  it("4004 は token を疑わせる", () => {
    const [next] = step(live(), { kind: "closed", code: 4004, jitter: 0 });
    expect(next.kind === "fatal" && next.reason).toContain("DISCORD_BOT_TOKEN");
  });

  it("fatal は何をしても動かない (人が直すまで張り直さない)", () => {
    const fatal: GatewayState = { kind: "fatal", reason: "だめ" };
    for (const event of [
      { kind: "connect_started" } as const,
      { kind: "heartbeat_due" } as const,
      { kind: "closed", code: null, jitter: 0 } as const,
    ]) {
      const [next, actions] = step(fatal, event);
      expect(next).toEqual(fatal);
      expect(actions).toEqual([]);
    }
  });
});

describe("メッセージの取り込み", () => {
  function messageEvent(d: unknown, seq = 12): GatewayPayload {
    return payload(0, { t: "MESSAGE_CREATE", s: seq, d });
  }

  const human = {
    id: "m-1",
    channel_id: "th-1",
    author: { id: "owner-1" },
    content: "この後 README も直して",
  };

  it("本文と書いた人を取り出し、seq を進める", () => {
    const [next, actions] = step(live(), {
      kind: "received",
      payload: messageEvent(human),
      jitter: 0,
    });
    expect(next.kind === "live" && next.resume?.seq).toBe(12);
    expect(actions).toEqual([
      {
        kind: "dispatch",
        message: {
          messageId: "m-1",
          channelId: "th-1",
          authorId: "owner-1",
          authorIsBot: false,
          content: "この後 README も直して",
        },
      },
    ]);
  });

  it("bot と webhook の発言は bot 印を付けて渡す (自分の投稿を拾い直さないため)", () => {
    const [, bot] = step(live(), {
      kind: "received",
      payload: messageEvent({ ...human, author: { id: "app-1", bot: true } }),
      jitter: 0,
    });
    expect(bot[0]?.kind === "dispatch" && bot[0].message.authorIsBot).toBe(true);

    // webhook 越しは author.id が webhook の id になるので、author.bot だけでは落とせない。
    const [, hook] = step(live(), {
      kind: "received",
      payload: messageEvent({ ...human, webhook_id: "wh-1" }),
      jitter: 0,
    });
    expect(hook[0]?.kind === "dispatch" && hook[0].message.authorIsBot).toBe(true);
  });

  it("形が読めないメッセージは落とすが、seq は進める", () => {
    const [next, actions] = step(live(), {
      kind: "received",
      payload: messageEvent({ channel_id: "th-1" }),
      jitter: 0,
    });
    expect(actions).toEqual([]);
    expect(next.kind === "live" && next.resume?.seq).toBe(12);
  });

  it("MESSAGE_CREATE 以外は何も起こさない", () => {
    const [, actions] = step(live(), {
      kind: "received",
      payload: payload(0, { t: "TYPING_START", s: 13, d: {} }),
      jitter: 0,
    });
    expect(actions).toEqual([]);
  });
});
