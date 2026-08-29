/**
 * Discord Gateway プロトコルの純粋層。接続の状態遷移をここに閉じ込め、`DiscordGatewayDO` は
 * 「WebSocket を開く / 送る / alarm を張る / 取り込みを呼ぶ」だけにする。
 *
 * なぜ Gateway が要るか: **素の文 (MESSAGE_CREATE) を HTTP で受け取る手段が Discord に無い**。
 * webhook で飛んでくるのは Social SDK 由来の一部イベントだけで、チャンネルの発言は今も
 * 常時接続の WebSocket でしか来ない。Interactions (`/claude`・ボタン) は HTTP のままでよい。
 *
 * なぜ純粋関数に切るか: Gateway の不具合は本番でしか出ない。heartbeat の遅れ、ゾンビ接続、
 * op 9 の `d:false`、close 4014 はどれも «Discord がそう振る舞ったとき» にしか起きず、
 * 統合テストでは踏めない。入力を手で作れば全経路を踏める。
 *
 * token をこの層に持ち込まない。`identify` / `resume` は **意図だけ**を action で表し、
 * JSON の組み立て (= token の埋め込み) は DO が行う。テストの入力にも token が現れない。
 *
 * https://discord.com/developers/docs/events/gateway
 */

/**
 * GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15)。**他を足さない** — intent は
 * «受け取れるイベント» であると同時に «Discord から流れてくる個人情報の範囲» でもある。
 *
 * MESSAGE_CONTENT は privileged。Developer Portal の Bot ページで有効にしていないと、
 * 接続そのものが close 4014 で切られる (本文が空で届くのではない)。
 */
export const GATEWAY_INTENTS = (1 << 9) | (1 << 15);

/** 初回接続用。再開は READY で貰う `resume_gateway_url` を使う。 */
export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/**
 * シングルトンであることがコスト方針の前提。outbound WebSocket は hibernation 非対応で、
 * 繋いでいる間ずっと duration 課金になる (常時 1 つで月 約 324,000 GB-s = 含有枠 400,000 の内側)。
 * 2 つ作ると枠を超える。
 */
export const GATEWAY_DO_NAME = "main";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** 短時間に張り直しすぎると identify のレート制限に当たる。窓と本数で抑える。 */
export const RECONNECT_WINDOW_MS = 60_000;
const RECONNECT_MAX_IN_WINDOW = 5;
const RECONNECT_THROTTLE_MS = 60_000;

/* ---- payload ---- */

export type GatewayPayload = Readonly<{
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 外枠だけを検証し、`d` は unknown のまま通す (op ごとに形が違うため)。
 * 知らないフィールドは黙って捨てる — Discord は将来フィールドを増やす。
 */
export function parseGatewayPayload(raw: unknown): GatewayPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.op !== "number" || !Number.isInteger(raw.op)) return null;
  const s = typeof raw.s === "number" && Number.isInteger(raw.s) ? raw.s : null;
  const t = typeof raw.t === "string" ? raw.t : null;
  return { op: raw.op, d: raw.d ?? null, s, t };
}

/** Gateway から拾う唯一のイベント。添付もリンクも本文として扱わない (本文だけを渡す)。 */
export type InboundMessage = Readonly<{
  messageId: string;
  channelId: string;
  authorId: string;
  /** bot / webhook の発言は自分の投稿を含めて無視する。 */
  authorIsBot: boolean;
  content: string;
}>;

function parseMessage(d: unknown): InboundMessage | null {
  if (!isRecord(d)) return null;
  const messageId = str(d, "id");
  const channelId = str(d, "channel_id");
  if (!messageId || !channelId) return null;

  const author = d.author;
  if (!isRecord(author)) return null;
  const authorId = str(author, "id");
  if (!authorId) return null;

  // webhook 越しの投稿は `author.id` が webhook の id になるので、`author.bot` だけでは
  // 自分の代理投稿を落とせない。`webhook_id` があれば無条件で bot 扱いにする。
  const authorIsBot = author.bot === true || typeof d.webhook_id === "string";

  return {
    messageId,
    channelId,
    authorId,
    authorIsBot,
    content: typeof d.content === "string" ? d.content : "",
  };
}

/* ---- 状態 ---- */

export type Resume = Readonly<{ sessionId: string; resumeUrl: string; seq: number }>;

export type GatewayState =
  /** ソケットが無い。`attempt` は backoff の段数。 */
  | Readonly<{ kind: "disconnected"; attempt: number; resume: Resume | null }>
  /** ソケットは開いたが HELLO がまだ。 */
  | Readonly<{ kind: "connecting"; attempt: number; resume: Resume | null }>
  /** HELLO を受けて heartbeat を回している。`ready` は READY / RESUMED を受けたか。 */
  | Readonly<{
      kind: "live";
      intervalMs: number;
      awaitingAck: boolean;
      ready: boolean;
      resume: Resume | null;
    }>
  /** 設定を直さない限り張り直しても同じ結果になる。人が `/gateway/reset` で解く。 */
  | Readonly<{ kind: "fatal"; reason: string }>;

export const initialGatewayState: GatewayState = {
  kind: "disconnected",
  attempt: 0,
  resume: null,
};

export type GatewayEvent =
  | Readonly<{ kind: "connect_started" }>
  | Readonly<{ kind: "received"; payload: GatewayPayload; jitter: number }>
  | Readonly<{ kind: "closed"; code: number | null; jitter: number }>
  | Readonly<{ kind: "heartbeat_due" }>;

export type GatewayAction =
  | Readonly<{ kind: "identify" }>
  | Readonly<{ kind: "resume"; sessionId: string; seq: number }>
  | Readonly<{ kind: "heartbeat"; seq: number | null }>
  | Readonly<{ kind: "schedule_heartbeat"; delayMs: number }>
  | Readonly<{ kind: "close"; code: number | undefined }>
  | Readonly<{ kind: "reconnect"; delayMs: number }>
  | Readonly<{ kind: "dispatch"; message: InboundMessage }>;

export type GatewayStep = readonly [GatewayState, readonly GatewayAction[]];

/* ---- close code ---- */

/**
 * 張り直しても同じ結果になる close code。**理由を人の言葉で持つ** — Gateway が上がらない
 * ときに見える手掛かりはここだけで、番号だけ出しても «何を直せばいいか» が誰にも分からない。
 */
const FATAL_CLOSE: ReadonlyMap<number, string> = new Map([
  [4004, "bot token が違います (DISCORD_BOT_TOKEN)"],
  [4010, "shard の指定が不正です"],
  [4011, "sharding が必要です"],
  [4012, "Gateway の API version が不正です"],
  [4013, "intent の指定が不正です"],
  [
    4014,
    "MESSAGE CONTENT INTENT が Developer Portal で有効になっていません (Bot → Privileged Gateway Intents)",
  ],
]);

/** 4009 (session timeout) と 4007 (seq が古い) は再開できないので、印を捨てて張り直す。 */
const RESUME_IMPOSSIBLE = new Set([4007, 4009]);

export function backoffMs(attempt: number, jitter: number): number {
  const base = Math.min(BACKOFF_MIN_MS * 2 ** Math.max(attempt, 0), BACKOFF_MAX_MS);
  // 揺らぎは «同じ瞬間に何度も張り直す» を避けるため。半分〜満額に散らす。
  return Math.round(base * (0.5 + jitter * 0.5));
}

/**
 * 再接続が短時間に集中していたら 60 秒待たせる。identify は 1 日 1000 回の制限があり、
 * 張っては切れるループに入ると静かに使い切って «token は正しいのに繋がらない» になる。
 */
export function throttleReconnect(
  delayMs: number,
  recentAttempts: readonly number[],
  now: number,
): number {
  const recent = pruneReconnects(recentAttempts, now);
  return recent.length >= RECONNECT_MAX_IN_WINDOW
    ? Math.max(delayMs, RECONNECT_THROTTLE_MS)
    : delayMs;
}

export function pruneReconnects(attempts: readonly number[], now: number): number[] {
  return attempts.filter((at) => now - at < RECONNECT_WINDOW_MS);
}

/**
 * Workers の `fetch` は **`wss://` を受け取らない** (`Fetch API cannot load: wss://…` で
 * 即座に失敗し、ソケットが開かないので原因が «接続できない» としか見えない)。
 *
 * Discord のドキュメントも `resume_gateway_url` も `wss://` で書かれているので、定数と
 * 状態はその形のまま持ち、**渡す直前にここだけで** `https://` へ直す。
 */
function toFetchUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://");
}

/** 再開できるなら `resume_gateway_url`、できないなら初回用の URL。 */
export function gatewayConnectUrl(state: GatewayState): string {
  const resume = "resume" in state ? state.resume : null;
  // resume_gateway_url は query を持たない形で来るので、こちらで付ける。
  return toFetchUrl(resume ? `${resume.resumeUrl}?v=10&encoding=json` : GATEWAY_URL);
}

export function gatewayIsHealthy(state: GatewayState): boolean {
  return state.kind === "live" && state.ready;
}

/* ---- 遷移 ---- */

function disconnected(attempt: number, resume: Resume | null, jitter: number): GatewayStep {
  return [
    { kind: "disconnected", attempt: attempt + 1, resume },
    [{ kind: "reconnect", delayMs: backoffMs(attempt, jitter) }],
  ];
}

function resumeOf(state: GatewayState): Resume | null {
  return "resume" in state ? state.resume : null;
}

/** `s` が付いている payload は必ず seq を進める (resume はこの値を送る)。 */
function advance(resume: Resume | null, seq: number | null): Resume | null {
  if (resume === null || seq === null) return resume;
  return { ...resume, seq };
}

export function step(state: GatewayState, event: GatewayEvent): GatewayStep {
  if (state.kind === "fatal") return [state, []];

  switch (event.kind) {
    case "connect_started":
      return [{ kind: "connecting", attempt: resumeAttempt(state), resume: resumeOf(state) }, []];

    case "closed": {
      const reason = event.code === null ? null : FATAL_CLOSE.get(event.code);
      if (reason !== undefined && reason !== null) return [{ kind: "fatal", reason }, []];
      const keep =
        event.code !== null && RESUME_IMPOSSIBLE.has(event.code) ? null : resumeOf(state);
      return disconnected(resumeAttempt(state), keep, event.jitter);
    }

    case "heartbeat_due": {
      if (state.kind !== "live") return [state, []];
      if (state.awaitingAck) {
        // 前回の heartbeat に op 11 が返っていない = ゾンビ。Discord は heartbeat を受けたら
        // 必ず ACK を返すので、interval 1 回ぶん無反応なら TCP が生きていても Gateway は死んでいる。
        // これを見ないと «送っているのに何も届かない» が無言で続く。
        // 4000 番台で閉じると Discord 側はセッションを残すので、張り直しで resume できる。
        return [
          state,
          [
            { kind: "close", code: 4000 },
            { kind: "reconnect", delayMs: 0 },
          ],
        ];
      }
      return [
        { ...state, awaitingAck: true },
        [
          { kind: "heartbeat", seq: state.resume?.seq ?? null },
          { kind: "schedule_heartbeat", delayMs: state.intervalMs },
        ],
      ];
    }

    case "received":
      return received(state, event.payload, event.jitter);

    default:
      return [state, []];
  }
}

function resumeAttempt(state: GatewayState): number {
  if (state.kind === "disconnected" || state.kind === "connecting") return state.attempt;
  // 一度 live まで行けたなら段数を捨てる (次の失敗は 1 秒から数え直す)。
  return 0;
}

function received(state: GatewayState, payload: GatewayPayload, jitter: number): GatewayStep {
  switch (payload.op) {
    /* HELLO */
    case 10: {
      const interval = helloInterval(payload.d);
      if (interval === null) {
        // 形が違う HELLO では heartbeat の間隔が決まらない。張り直す。
        return disconnected(resumeAttempt(state), resumeOf(state), jitter);
      }
      const resume = resumeOf(state);
      const live: GatewayState = {
        kind: "live",
        intervalMs: interval,
        awaitingAck: false,
        ready: false,
        resume,
      };
      const handshake: GatewayAction = resume
        ? { kind: "resume", sessionId: resume.sessionId, seq: resume.seq }
        : { kind: "identify" };
      // 最初の heartbeat は jitter で散らす (Discord の指示)。
      return [
        live,
        [handshake, { kind: "schedule_heartbeat", delayMs: Math.round(interval * jitter) }],
      ];
    }

    /* HEARTBEAT (サーバーからの催促) */
    case 1: {
      if (state.kind !== "live") return [state, []];
      return [state, [{ kind: "heartbeat", seq: state.resume?.seq ?? null }]];
    }

    /* HEARTBEAT ACK */
    case 11: {
      if (state.kind !== "live") return [state, []];
      return [{ ...state, awaitingAck: false }, []];
    }

    /* RECONNECT */
    case 7:
      return [
        { kind: "disconnected", attempt: 0, resume: resumeOf(state) },
        [
          { kind: "close", code: 4000 },
          { kind: "reconnect", delayMs: 0 },
        ],
      ];

    /* INVALID SESSION */
    case 9: {
      // d:true なら再開できる。false なら印を捨てて identify からやり直す。
      const keep = payload.d === true ? resumeOf(state) : null;
      return [
        { kind: "disconnected", attempt: 0, resume: keep },
        [
          { kind: "close", code: 4000 },
          // identify のレート制限を避けるため、Discord は 1〜5 秒待てと言っている。
          { kind: "reconnect", delayMs: 1_000 + Math.round(jitter * 4_000) },
        ],
      ];
    }

    /* DISPATCH */
    case 0:
      return dispatch(state, payload);

    default:
      return [state, []];
  }
}

function helloInterval(d: unknown): number | null {
  if (!isRecord(d)) return null;
  const value = d.heartbeat_interval;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function dispatch(state: GatewayState, payload: GatewayPayload): GatewayStep {
  if (state.kind !== "live") return [state, []];
  const seq = payload.s;

  if (payload.t === "READY") {
    const ready = parseReady(payload.d);
    if (!ready) return [state, []];
    return [
      {
        ...state,
        ready: true,
        resume: { sessionId: ready.sessionId, resumeUrl: ready.resumeUrl, seq: seq ?? 0 },
      },
      [],
    ];
  }

  if (payload.t === "RESUMED") {
    return [{ ...state, ready: true, resume: advance(state.resume, seq) }, []];
  }

  const next: GatewayState = { ...state, resume: advance(state.resume, seq) };
  if (payload.t !== "MESSAGE_CREATE") return [next, []];

  const message = parseMessage(payload.d);
  // 形が読めないメッセージは落とす。1 件のために接続を捨てない。
  if (!message) return [next, []];
  return [next, [{ kind: "dispatch", message }]];
}

function parseReady(d: unknown): { sessionId: string; resumeUrl: string } | null {
  if (!isRecord(d)) return null;
  const sessionId = str(d, "session_id");
  const resumeUrl = str(d, "resume_gateway_url");
  return sessionId && resumeUrl ? { sessionId, resumeUrl } : null;
}
