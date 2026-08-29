/**
 * Discord REST の薄いラッパ。bot token を持つのはここだけ。
 *
 * 失敗しても呼び出し側の本処理は止めない (通知が出ないことより、セッションが進まないことの方が
 * 悪い) が、**無言では握らない** — 何が返ったかを呼び出し側へ返し、記録に残せるようにする。
 */

const API_BASE = "https://discord.com/api/v10";

export type DiscordResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; status: number; detail: string }>;

export type MessagePayload = {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  allowed_mentions?: { parse: string[] };
};

/** Discord のスレッド系チャンネル種別 (PUBLIC / PRIVATE / ANNOUNCEMENT)。 */
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

export function isThreadChannelType(type: number | undefined): boolean {
  return type !== undefined && THREAD_CHANNEL_TYPES.has(type);
}

export class DiscordRest {
  constructor(
    private readonly botToken: string,
    private readonly applicationId: string,
  ) {}

  private async call<T>(
    path: string,
    init: { method: string; body?: unknown },
    auth: "bot" | "none",
  ): Promise<DiscordResult<T>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth === "bot") headers.authorization = `Bot ${this.botToken}`;

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      return { ok: false, status: 0, detail: `fetch failed: ${String(error)}` };
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      return { ok: false, status: response.status, detail };
    }
    if (response.status === 204) return { ok: true, value: undefined as T };
    return { ok: true, value: (await response.json()) as T };
  }

  /** 応答を保留 (type 5) したあとの本体差し替え。interaction token は 15 分で切れる。 */
  editOriginalResponse(
    interactionToken: string,
    payload: MessagePayload,
  ): Promise<DiscordResult<{ id: string; channel_id: string }>> {
    return this.call(
      `/webhooks/${this.applicationId}/${interactionToken}/messages/@original`,
      { method: "PATCH", body: payload },
      "none",
    );
  }

  createThreadFromMessage(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<DiscordResult<{ id: string }>> {
    return this.call(
      `/channels/${channelId}/messages/${messageId}/threads`,
      // 1440 = 1 日。放置したスレッドが並び続けるのを避けるための既定。
      { method: "POST", body: { name: name.slice(0, 100), auto_archive_duration: 1440 } },
      "bot",
    );
  }

  postMessage(channelId: string, payload: MessagePayload): Promise<DiscordResult<{ id: string }>> {
    return this.call(`/channels/${channelId}/messages`, { method: "POST", body: payload }, "bot");
  }

  editMessage(
    channelId: string,
    messageId: string,
    payload: MessagePayload,
  ): Promise<DiscordResult<{ id: string }>> {
    return this.call(
      `/channels/${channelId}/messages/${messageId}`,
      { method: "PATCH", body: payload },
      "bot",
    );
  }
}
