import { DurableObject } from "cloudflare:workers";
import { applyInbound } from "../discord/inbound";
import {
  GATEWAY_DO_NAME,
  GATEWAY_INTENTS,
  type GatewayAction,
  type GatewayState,
  type GatewayStep,
  gatewayConnectUrl,
  gatewayIsHealthy,
  type InboundMessage,
  initialGatewayState,
  parseGatewayPayload,
  pruneReconnects,
  step,
  throttleReconnect,
} from "../domain/gateway";
import type { Env } from "../env";

/**
 * Discord Gateway への常時接続。**シングルトン** (`idFromName("main")`)。
 *
 * ## なぜ Durable Object なのか
 *
 * 素の文 (MESSAGE_CREATE) は WebSocket でしか来ない (`domain/gateway.ts` 冒頭)。Worker は
 * リクエストごとに消えるので、接続を持ち続けられる場所は DO しかない。
 *
 * ## なぜ setInterval ではなく alarm なのか
 *
 * **outbound WebSocket が DO を生かすのは 1 接続あたり最長 15 分**と決まっている
 * (Cloudflare の課金ドキュメントに明記)。その先は evict されうるので `setInterval` は必ず
 * どこかで消える。alarm なら evict された後でも Cloudflare が起こしてくれるので、heartbeat も
 * 張り直しも続く。さらに 5 分 cron の `POST /ensure` が «alarm ごと消えた» を埋める
 * (DO は自分では起動できない)。
 *
 * ## コスト
 *
 * outbound WebSocket は hibernation 非対応なので、繋いでいる間ずっと duration 課金になる。
 * 128MB × 30 日 = 約 324,000 GB-s で、Workers Paid の含有枠 400,000 GB-s の内側に収まる。
 * **この DO を 2 つ作ると枠を超える**ので、シングルトンであることが前提になっている。
 *
 * 状態遷移はすべて `domain/gateway.ts` の `step` が持ち、このクラスは
 * 「WebSocket を開く / 送る / alarm を張る / 取り込みを呼ぶ」だけを行う。
 */

/** 予約が何も無いときの空回り alarm。取りこぼしの最終防御。 */
const IDLE_ALARM_MS = 60_000;

const KEY_STATE = "state";
const KEY_RECONNECTS = "reconnects";
const KEY_HEARTBEAT_AT = "heartbeatAt";
const KEY_CONNECT_AT = "connectAt";
const KEY_LAST_EVENT_AT = "lastEventAt";

export type GatewayStatus = Readonly<{
  state: GatewayState["kind"] | "stopped";
  healthy: boolean;
  fatalReason: string | null;
  /** 最後に Discord から何か届いた時刻。**繋がっているのに無音**を見分けるための値。 */
  lastEventAt: number | null;
  connected: boolean;
}>;

export class DiscordGatewayDO extends DurableObject<Env> {
  /**
   * storage に入れない — WebSocket はシリアライズできないし、DO が evict されたら接続も
   * 切れているので「メモリにあるかどうか」がそのまま「繋がっているかどうか」になる。
   */
  private socket: WebSocket | null = null;

  /** fetch が解決するまで `socket` は null のままで、その間に来た 2 本目の要求を弾けないため。 */
  private connecting = false;

  /**
   * 取り込みを «届いた順» に直列化する。`blockConcurrencyWhile` は使わない — 取り込みは
   * routine の起動 (数秒) を含むので、protocol の処理まで止めると heartbeat が遅れる。
   */
  private ingesting: Promise<void> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ensure") {
      return this.respond(() => this.ensure());
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      return this.respond(() => this.reset());
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.respond(() => this.readStatus());
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * heartbeat と張り直しの両方を駆動する。**例外を外に出さない** — alarm が throw すると
   * Cloudflare が再試行するが、原因が残っていれば同じ場所で落ち続ける。ログに落として次を張る。
   */
  override async alarm(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      console.warn("[gateway] alarm failed", error);
    }
    await this.scheduleAlarm();
  }

  private async respond(body: () => Promise<GatewayStatus>): Promise<Response> {
    try {
      return Response.json(await body());
    } catch (error) {
      console.warn("[gateway] request failed", error);
      return Response.json({ error: "gateway_error" }, { status: 500 });
    }
  }

  /**
   * 5 分 cron から呼ばれる。既に繋がっているときは何もしない。`fatal` でも張らない —
   * ここで張ると «直らない設定で 5 分ごとに永久リトライ» になり、close code を
   * 特別扱いした意味が消える (復帰は `/gateway/reset`)。
   */
  private async ensure(): Promise<GatewayStatus> {
    if (!this.token()) return this.readStatus();
    const state = await this.loadState();
    if (state.kind === "fatal") return this.readStatus();

    if (this.socket !== null) {
      // 繋がっている。evict 後に alarm が消えている可能性があるので張り直しておく。
      await this.scheduleAlarm();
      return this.readStatus();
    }
    // backoff / レート制限の予約が先にあるなら待つ (cron で追い抜かない)。
    const connectAt = await this.readNumber(KEY_CONNECT_AT);
    if (connectAt !== null && Date.now() < connectAt) {
      await this.scheduleAlarm();
      return this.readStatus();
    }
    await this.ctx.storage.delete(KEY_CONNECT_AT);
    await this.openSocket();
    await this.scheduleAlarm();
    return this.readStatus();
  }

  /**
   * `fatal` を解いて張り直す (人の操作)。
   *
   * `fatal` からの自動復帰を作らない代わりに、設定を直した人がその場で試せる経路を 1 つ用意する。
   * これが無いと Portal で intent を有効にしても Gateway が上がらず、原因が «fatal のまま» だと
   * 気付ける人が居ない。再接続レートの記録も消す (人が押した 1 回を待たせない)。
   */
  private async reset(): Promise<GatewayStatus> {
    this.closeSocket();
    await this.saveState(initialGatewayState);
    await this.ctx.storage.delete([KEY_RECONNECTS, KEY_HEARTBEAT_AT, KEY_CONNECT_AT]);
    if (this.token()) await this.openSocket();
    await this.scheduleAlarm();
    return this.readStatus();
  }

  private async readStatus(): Promise<GatewayStatus> {
    const state = await this.loadState();
    return {
      state: this.token() ? state.kind : "stopped",
      healthy: this.socket !== null && gatewayIsHealthy(state),
      fatalReason: state.kind === "fatal" ? state.reason : null,
      lastEventAt: await this.readNumber(KEY_LAST_EVENT_AT),
      connected: this.socket !== null,
    };
  }

  private token(): string {
    return this.env.DISCORD_BOT_TOKEN ?? "";
  }

  /**
   * WebSocket を張る。Workers の outbound WebSocket は `fetch` + `Upgrade` ヘッダで開き、
   * `response.webSocket` を `accept()` する (`ctx.acceptWebSocket` は inbound 専用)。
   */
  private async openSocket(): Promise<void> {
    const state = await this.loadState();
    if (state.kind === "fatal" || this.socket !== null) return;
    // `this.socket` は fetch が解決するまで null なので、それだけでは «張っている途中» を弾けない。
    // cron の `/ensure` が fetch を待っている間に alarm が回ってくると両方が通って 2 本開く
    // (先に開いた方は変数から外れて close も無視されるので、Discord がタイムアウトさせるまで
    // セッションが残る = identify のレート制限を無駄に食う)。
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.openSocketOnce(state);
    } finally {
      this.connecting = false;
    }
  }

  private async openSocketOnce(state: GatewayState): Promise<void> {
    const now = Date.now();
    // 張り直しの時刻を残す。`throttleReconnect` がこれを見て 60 秒待たせる。
    const recent = pruneReconnects(
      (await this.ctx.storage.get<number[]>(KEY_RECONNECTS)) ?? [],
      now,
    );
    await this.ctx.storage.put(KEY_RECONNECTS, [...recent, now]);

    const [connecting] = step(state, { kind: "connect_started" });
    await this.saveState(connecting);

    let socket: WebSocket | null = null;
    try {
      const response = await fetch(gatewayConnectUrl(connecting), {
        headers: { Upgrade: "websocket" },
      });
      socket = response.webSocket ?? null;
    } catch (error) {
      // token を載せない。種別だけ。
      console.warn("[gateway] connect failed", { error: String(error) });
    }
    if (!socket) {
      // 開けなかった = close と同じ扱い (backoff して張り直す)。
      await this.apply(step(connecting, { kind: "closed", code: null, jitter: Math.random() }));
      return;
    }

    socket.accept();
    this.socket = socket;
    const owned = socket;
    socket.addEventListener("message", (event) => {
      void this.serialize(() => this.onMessage(owned, event));
    });
    socket.addEventListener("close", (event) => {
      void this.serialize(() => this.onSocketGone(owned, event.code));
    });
    socket.addEventListener("error", () => {
      void this.serialize(() => this.onSocketGone(owned, null));
    });
  }

  /**
   * protocol の処理を直列化する。`seq` の書き込みが競合すると resume が壊れるため。
   * callback が throw すると DO が再起動されるので、必ず中で握る。
   */
  private serialize(body: () => Promise<void>): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await body();
      } catch (error) {
        console.warn("[gateway] handler failed", error);
      }
    });
  }

  private closeSocket(code?: number): void {
    const socket = this.socket;
    if (!socket) return;
    // 先に手放す。close イベントが返ってきても `owned` 比較で無視される。
    this.socket = null;
    try {
      socket.close(code);
    } catch {
      // 既に閉じている。片付けるものは無い。
    }
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      console.warn("[gateway] send failed", { error: String(error) });
    }
  }

  private async onMessage(owned: WebSocket, event: MessageEvent): Promise<void> {
    if (this.socket !== owned) return;
    // encoding=json なので文字列しか来ない (バイナリは etf / zlib のときだけ)。
    if (typeof event.data !== "string") return;

    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      console.warn("[gateway] payload is not json");
      return;
    }
    const payload = parseGatewayPayload(raw);
    // 例外を投げず無視する。Discord は将来フィールドを増やすため。
    if (!payload) {
      console.warn("[gateway] payload の形が読めません");
      return;
    }
    await this.apply(
      step(await this.loadState(), { kind: "received", payload, jitter: Math.random() }),
    );
    await this.scheduleAlarm();
  }

  private async onSocketGone(owned: WebSocket, code: number | null): Promise<void> {
    // 自分で閉じた / 既に別の接続に移っている。二重に backoff を積まない。
    if (this.socket !== owned) return;
    this.socket = null;
    await this.apply(step(await this.loadState(), { kind: "closed", code, jitter: Math.random() }));
    await this.scheduleAlarm();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const state = await this.loadState();
    // fatal では何もしない。alarm も張り直さない (`scheduleAlarm` が消す)。
    if (state.kind === "fatal") return;

    if (this.socket === null) {
      const connectAt = await this.readNumber(KEY_CONNECT_AT);
      // 予約が来ている / 予約が無い (evict された後) のどちらでも張り直す。これが watchdog の
      // 本体で、5 分 cron に頼らず自力でも戻れる。
      if (connectAt === null || now >= connectAt) {
        await this.ctx.storage.delete(KEY_CONNECT_AT);
        await this.openSocket();
      }
      return;
    }

    // ソケットは開いているのに HELLO が来ていない。HELLO は接続直後に来るので、alarm が
    // 回ってくるまで来ないのは死んでいる証拠。これを見ないと «開いたまま何も起きない» が
    // 永久に続く (heartbeat の予約がまだ無いのでゾンビ検出も働かない)。
    if (state.kind === "connecting") {
      this.closeSocket();
      await this.apply(step(state, { kind: "closed", code: null, jitter: Math.random() }));
      return;
    }

    const heartbeatAt = await this.readNumber(KEY_HEARTBEAT_AT);
    if (heartbeatAt !== null && now >= heartbeatAt) {
      await this.apply(step(state, { kind: "heartbeat_due" }));
    }
  }

  private async apply([next, actions]: GatewayStep): Promise<void> {
    await this.saveState(next);
    if (next.kind === "live" && next.ready) {
      // READY のときだけではなく **何か届くたび** に更新する。«繋がっているのに無音» は
      // ソケットが開いていることでは見分けられないので、これが唯一の手掛かりになる。
      await this.ctx.storage.put(KEY_LAST_EVENT_AT, Date.now());
    }
    if (next.kind === "fatal") {
      // 直し方が書いてある唯一の手掛かりなのでログにも残す。理由だけで token は載せない。
      console.warn("[gateway] fatal", { reason: next.reason });
    }
    for (const action of actions) {
      await this.run(action);
    }
  }

  private async run(action: GatewayAction): Promise<void> {
    const now = Date.now();
    switch (action.kind) {
      case "identify":
        this.send({
          op: 2,
          d: {
            token: this.token(),
            intents: GATEWAY_INTENTS,
            properties: { os: "linux", browser: "kanata", device: "kanata" },
          },
        });
        return;
      case "resume":
        this.send({
          op: 6,
          d: { token: this.token(), session_id: action.sessionId, seq: action.seq },
        });
        return;
      case "heartbeat":
        this.send({ op: 1, d: action.seq });
        return;
      case "schedule_heartbeat":
        await this.ctx.storage.put(KEY_HEARTBEAT_AT, now + action.delayMs);
        return;
      case "close":
        this.closeSocket(action.code);
        return;
      case "reconnect": {
        this.closeSocket();
        const recent = pruneReconnects(
          (await this.ctx.storage.get<number[]>(KEY_RECONNECTS)) ?? [],
          now,
        );
        await this.ctx.storage.put(
          KEY_CONNECT_AT,
          now + throttleReconnect(action.delayMs, recent, now),
        );
        await this.ctx.storage.delete(KEY_HEARTBEAT_AT);
        return;
      }
      case "dispatch":
        this.enqueueIngest(action.message);
        return;
    }
  }

  /**
   * 取り込みは protocol の外で、届いた順に 1 件ずつ流す。
   *
   * routine の起動が数秒かかるので、ここを待つと heartbeat が遅れてゾンビ判定に入る。
   * 順序は保つ — 「A して」「あと B も」が入れ替わると意味が変わる。
   */
  private enqueueIngest(message: InboundMessage): void {
    this.ingesting = this.ingesting.then(() => this.ingest(message));
    this.ctx.waitUntil(this.ingesting);
  }

  /**
   * 失敗しても Gateway は止めない。1 件の取り込み失敗で接続を捨てると、壊れたメッセージ
   * 1 通が以降の全ての発言を落とす。
   */
  private async ingest(message: InboundMessage): Promise<void> {
    try {
      const outcome = await applyInbound(this.env, {
        // Discord ではスレッドもチャンネルなので、`channel_id` がそのままスレッド。
        threadId: message.channelId,
        messageId: message.messageId,
        authorId: message.authorId,
        authorIsBot: message.authorIsBot,
        text: message.content,
      });
      // 本文を載せない。何が起きたかだけ。
      if (outcome.kind === "ignored") return;
      console.log("[gateway] inbound", { outcome: outcome.kind });
    } catch (error) {
      console.warn("[gateway] ingest failed", error);
    }
  }

  private async loadState(): Promise<GatewayState> {
    const raw = await this.ctx.storage.get<GatewayState>(KEY_STATE);
    return raw ?? initialGatewayState;
  }

  private async saveState(state: GatewayState): Promise<void> {
    await this.ctx.storage.put(KEY_STATE, state);
  }

  private async readNumber(key: string): Promise<number | null> {
    const raw = await this.ctx.storage.get<unknown>(key);
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }

  /**
   * 予約の最小値に合わせる。予約が無いときも 60 秒後に張るのは、evict されて `this.socket` が
   * 消えた状態を自力で拾うため。`fatal` のときだけは消す — 直すのは人なので、待っても変わらない
   * 状態で 1 分ごとに DO を起こす意味が無い。
   */
  private async scheduleAlarm(): Promise<void> {
    const state = await this.loadState();
    if (state.kind === "fatal") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const candidates = [
      await this.readNumber(KEY_HEARTBEAT_AT),
      await this.readNumber(KEY_CONNECT_AT),
    ].filter((at): at is number => at !== null);
    const at = candidates.length > 0 ? Math.min(...candidates) : now + IDLE_ALARM_MS;
    await this.ctx.storage.setAlarm(Math.max(at, now));
  }
}

/** 外から DO を掴むときの唯一の口。名前を散らさない。 */
export function gatewayStub(env: Env): DurableObjectStub {
  return env.GATEWAY.get(env.GATEWAY.idFromName(GATEWAY_DO_NAME));
}
