import { nowIso } from "../domain/time";

/**
 * SQL はここだけが持つ。ハンドラ (`discord/` `mcp/` `hooks/`) は生 SQL を書かない。
 * 返すのは行 dict ではなく値オブジェクト。
 */

export type SessionStatus = "queued" | "running" | "waiting" | "done" | "failed";

export type Session = Readonly<{
  sessionKey: string;
  project: string;
  prompt: string;
  status: SessionStatus;
  requesterId: string;
  channelId: string;
  threadId: string | null;
  ccSessionId: string | null;
  ccSessionUrl: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type Ask = Readonly<{
  askId: string;
  sessionKey: string;
  question: string;
  options: readonly string[];
  allowFreeText: boolean;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  messageId: string | null;
  createdAt: string;
}>;

type SessionRow = {
  session_key: string;
  project: string;
  prompt: string;
  status: string;
  requester_id: string;
  channel_id: string;
  thread_id: string | null;
  cc_session_id: string | null;
  cc_session_url: string | null;
  created_at: string;
  updated_at: string;
};

type AskRow = {
  ask_id: string;
  session_key: string;
  question: string;
  options_json: string;
  allow_free_text: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  message_id: string | null;
  created_at: string;
};

function toSession(row: SessionRow): Session {
  return {
    sessionKey: row.session_key,
    project: row.project,
    prompt: row.prompt,
    status: row.status as SessionStatus,
    requesterId: row.requester_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    ccSessionId: row.cc_session_id,
    ccSessionUrl: row.cc_session_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAsk(row: AskRow): Ask {
  // options_json は自分で書いた値しか入らないが、壊れていたら «選択肢なし» に倒す。
  // ここで例外を投げると、答えを待っているセッションが二度と進めなくなる。
  let options: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.options_json);
    if (Array.isArray(parsed)) options = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    options = [];
  }
  return {
    askId: row.ask_id,
    sessionKey: row.session_key,
    question: row.question,
    options,
    allowFreeText: row.allow_free_text === 1,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

export class Repo {
  constructor(private readonly db: D1Database) {}

  /* ---- sessions ---- */

  async createSession(input: {
    sessionKey: string;
    project: string;
    prompt: string;
    requesterId: string;
    channelId: string;
  }): Promise<Session> {
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO sessions
           (session_key, project, prompt, status, requester_id, channel_id, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .bind(
        input.sessionKey,
        input.project,
        input.prompt,
        input.requesterId,
        input.channelId,
        at,
        at,
      )
      .run();
    return {
      sessionKey: input.sessionKey,
      project: input.project,
      prompt: input.prompt,
      status: "queued",
      requesterId: input.requesterId,
      channelId: input.channelId,
      threadId: null,
      ccSessionId: null,
      ccSessionUrl: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  async getSession(sessionKey: string): Promise<Session | null> {
    const row = await this.db
      .prepare("SELECT * FROM sessions WHERE session_key = ?")
      .bind(sessionKey)
      .first<SessionRow>();
    return row ? toSession(row) : null;
  }

  async attachThread(sessionKey: string, threadId: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET thread_id = ?, updated_at = ? WHERE session_key = ?")
      .bind(threadId, nowIso(), sessionKey)
      .run();
  }

  async attachCloudSession(
    sessionKey: string,
    ccSessionId: string,
    ccSessionUrl: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions
            SET cc_session_id = ?, cc_session_url = ?, status = 'running', updated_at = ?
          WHERE session_key = ?`,
      )
      .bind(ccSessionId, ccSessionUrl, nowIso(), sessionKey)
      .run();
  }

  async setStatus(sessionKey: string, status: SessionStatus): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE session_key = ?")
      .bind(status, nowIso(), sessionKey)
      .run();
  }

  async listRecentSessions(limit: number): Promise<Session[]> {
    const result = await this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<SessionRow>();
    return (result.results ?? []).map(toSession);
  }

  /* ---- asks ---- */

  async createAsk(input: {
    askId: string;
    sessionKey: string;
    question: string;
    options: readonly string[];
    allowFreeText: boolean;
  }): Promise<Ask> {
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO asks
           (ask_id, session_key, question, options_json, allow_free_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.askId,
        input.sessionKey,
        input.question,
        JSON.stringify(input.options),
        input.allowFreeText ? 1 : 0,
        at,
      )
      .run();
    return {
      askId: input.askId,
      sessionKey: input.sessionKey,
      question: input.question,
      options: input.options,
      allowFreeText: input.allowFreeText,
      answer: null,
      answeredBy: null,
      answeredAt: null,
      messageId: null,
      createdAt: at,
    };
  }

  async getAsk(askId: string): Promise<Ask | null> {
    const row = await this.db
      .prepare("SELECT * FROM asks WHERE ask_id = ?")
      .bind(askId)
      .first<AskRow>();
    return row ? toAsk(row) : null;
  }

  /**
   * そのスレッドで «**生きている**セッションが待っている質問» を 1 つ引く。
   *
   * これがあると `/claude` の意味が 2 つになる: 待っている質問があればその **回答**、
   * 無ければ新しいセッションの **起動**。スレッドが 1 本の会話に見えるのはこの分岐のおかげ。
   *
   * 生死を見るのが肝。落ちたセッションの未回答の質問が残っていると、以後そのスレッドの
   * `/claude` を永久に飲み込む «穴» になる (答えを受け取る相手がもう居ない)。
   * 握っている間だけ `touchSession` が印を更新するので、それが新しいものだけを «生きている» とみなす。
   */
  async findLiveAskInThread(threadId: string, freshSinceIso: string): Promise<Ask | null> {
    const row = await this.db
      .prepare(
        `SELECT a.* FROM asks a
           JOIN sessions s ON s.session_key = a.session_key
          WHERE s.thread_id = ? AND a.answer IS NULL AND s.updated_at >= ?
          ORDER BY a.created_at DESC
          LIMIT 1`,
      )
      .bind(threadId, freshSinceIso)
      .first<AskRow>();
    return row ? toAsk(row) : null;
  }

  /** 握っている間の生存の印。**これが止まったセッションは死んだものとして扱う**。 */
  async touchSession(sessionKey: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?")
      .bind(nowIso(), sessionKey)
      .run();
  }

  async attachAskMessage(askId: string, messageId: string): Promise<void> {
    await this.db
      .prepare("UPDATE asks SET message_id = ? WHERE ask_id = ?")
      .bind(messageId, askId)
      .run();
  }

  /**
   * 未回答のときだけ書き込む。二重押し・連打で «後の押下が先の答えを上書きする» のを
   * 構造で防ぐ (画面側のガードだけに頼らない)。書けたかどうかを返す。
   */
  async answerAsk(askId: string, answer: string, answeredBy: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE asks SET answer = ?, answered_by = ?, answered_at = ?
          WHERE ask_id = ? AND answer IS NULL`,
      )
      .bind(answer, answeredBy, nowIso(), askId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /* ---- events ---- */

  async addEvent(sessionKey: string, kind: string, body: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO events (session_key, kind, body, created_at) VALUES (?, ?, ?, ?)")
      .bind(sessionKey, kind, body, nowIso())
      .run();
  }
}
