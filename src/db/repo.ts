import { newPlanId } from "../domain/ids";
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
  /** hook が転写ログから拾ってきたコンテキスト使用量。まだ 1 度も来ていなければ null。 */
  contextUsedTokens: number | null;
  contextOutputTokens: number | null;
  contextAt: string | null;
}>;

export type Ask = Readonly<{
  askId: string;
  sessionKey: string;
  question: string;
  options: readonly string[];
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  messageId: string | null;
  createdAt: string;
  /** Claude へ «返せた» 印。NULL = 往復が途中で切れて、まだ渡せていない。 */
  deliveredAt: string | null;
}>;

/**
 * 溜まっていた文をまとめて 1 つの «次の指示» に畳んだもの。
 *
 * **取り出す (`peekQueued`) と «渡した» 印を立てる (`markQueuedTaken`) は別の操作**。
 * 先に印を立てると、渡す側が失敗したときに文が宙に浮いて消える (実際にその形をしていた)。
 * 渡し切ってから印を立てるので、最悪でも «2 回渡る» で済む — 消えるよりずっとよい。
 */
export type QueuedBatch = Readonly<{
  text: string;
  /** 最初に書いた人。回答の記録に残す。 */
  authorId: string;
  /** 印 (リアクション) を付け替える相手。`/claude` 経由で溜めたぶんは空。 */
  messageIds: readonly string[];
  /** 印を立てる対象。**peek した行だけ**を指す (その後に届いた分を巻き込まない)。 */
  ids: readonly number[];
}>;

/** 実装計画 1 件。本文は R2 にあり、ここにあるのは «どこに何があるか» だけ。 */
export type Plan = Readonly<{
  /** 32hex。**そのまま公開 URL の鍵になる** (`/p/<plan_id>/`)。 */
  planId: string;
  /** `thread:<id>` か `session:<key>`。同じ場所の同じ slug は同じ計画。 */
  scope: string;
  slug: string;
  sessionKey: string;
  createdAt: string;
  updatedAt: string;
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
  ctx_used_tokens: number | null;
  ctx_output_tokens: number | null;
  ctx_at: string | null;
};

type PlanRow = {
  plan_id: string;
  scope: string;
  slug: string;
  session_key: string;
  created_at: string;
  updated_at: string;
};

type AskRow = {
  ask_id: string;
  session_key: string;
  question: string;
  options_json: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  message_id: string | null;
  created_at: string;
  delivered_at: string | null;
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
    contextUsedTokens: row.ctx_used_tokens,
    contextOutputTokens: row.ctx_output_tokens,
    contextAt: row.ctx_at,
  };
}

function toPlan(row: PlanRow): Plan {
  return {
    planId: row.plan_id,
    scope: row.scope,
    slug: row.slug,
    sessionKey: row.session_key,
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
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    messageId: row.message_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
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
      contextUsedTokens: null,
      contextOutputTokens: null,
      // DB には入れていない (hook が 1 度も来ていない印は NULL)。ここで `at` を返すと嘘になる。
      contextAt: null,
    };
  }

  async getSession(sessionKey: string): Promise<Session | null> {
    const row = await this.db
      .prepare("SELECT * FROM sessions WHERE session_key = ?")
      .bind(sessionKey)
      .first<SessionRow>();
    return row ? toSession(row) : null;
  }

  /**
   * そのスレッドの **最新の** セッション。素の文が届いたとき «誰との会話か» を引くのに使う。
   *
   * 1 スレッドに複数のセッションが並ぶことがある (前のが終わった後に書き足すと新しく起こす)。
   * 会話として続いているのは常に最後の 1 つなので、それだけを返す。
   */
  async findSessionByThread(threadId: string): Promise<Session | null> {
    const row = await this.db
      .prepare("SELECT * FROM sessions WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(threadId)
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

  /** 台帳を新しい順に見る。本番の経路では使わないが、テストが «何が起きたか» を確かめる口。 */
  async listRecentSessions(limit: number): Promise<Session[]> {
    const result = await this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<SessionRow>();
    return (result.results ?? []).map(toSession);
  }

  /**
   * **起動しそこねたまま残っているセッション。**
   *
   * `/claude` の続き (スレッド作成 → routine 起動) は `waitUntil` の中で走るが、そこは
   * **応答から 30 秒**で打ち切られる (Workers の仕様)。途中で切れると `queued` のまま残り、
   * `domain/inbound.ts` はそれを «起動直後» とみなして以後の発言を延々と溜め込む
   * (= 書いたのに何も起きない穴になる)。5 分 cron がこれで拾って畳む。
   */
  async listStuckQueued(createdBefore: string, limit: number): Promise<Session[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM sessions WHERE status = 'queued' AND created_at < ? ORDER BY created_at LIMIT ?",
      )
      .bind(createdBefore, limit)
      .all<SessionRow>();
    return (result.results ?? []).map(toSession);
  }

  /* ---- asks ---- */

  async createAsk(input: {
    askId: string;
    sessionKey: string;
    question: string;
    options: readonly string[];
  }): Promise<Ask> {
    const at = nowIso();
    await this.db
      .prepare(
        // `allow_free_text` は «✍️ 書く» ボタンがあった頃の列。ボタンは廃したが
        // NOT NULL なので 1 を入れ続ける (列を落とす移行を足すほどの実益が無い)。
        `INSERT INTO asks
           (ask_id, session_key, question, options_json, allow_free_text, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .bind(input.askId, input.sessionKey, input.question, JSON.stringify(input.options), at)
      .run();
    return {
      askId: input.askId,
      sessionKey: input.sessionKey,
      question: input.question,
      options: input.options,
      answer: null,
      answeredBy: null,
      answeredAt: null,
      messageId: null,
      createdAt: at,
      deliveredAt: null,
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
   * hook が拾ってきたコンテキスト使用量を記録する。
   *
   * **`updated_at` は触らない。** あれは «握りが生きている» の印で、これは «Claude が息を
   * している» の印。混ぜると、Stop hook が動いた (= ターンが終わった = もう握っていない)
   * セッションを「まだ待っている」と誤判定して、死んだ質問へ回答を書き込むことになる。
   */
  async saveContextUsage(
    sessionKey: string,
    usage: { usedTokens: number; outputTokens: number },
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET ctx_used_tokens = ?, ctx_output_tokens = ?, ctx_at = ?
          WHERE session_key = ?`,
      )
      .bind(usage.usedTokens, usage.outputTokens, nowIso(), sessionKey)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** 握っている間の生存の印。**これが止まったセッションは死んだものとして扱う**。 */
  async touchSession(sessionKey: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE session_key = ?")
      .bind(nowIso(), sessionKey)
      .run();
  }

  /**
   * **まだ Claude へ返せていない、いちばん新しい質問。**
   *
   * 握っている SSE は落ちることがあり、そのとき Claude に届くのは **ask_id を含まない**
   * エラー (`transport dropped mid-call`) なので `ask_wait` で拾い直せない。Claude にできるのは
   * `ask_human` を呼び直すことだけ。それを素通りさせると、同じ質問が Discord に 2 回出て、
   * 切れている間に入った答えは宙に浮く (実際に 1 つ失った)。
   *
   * **«いちばん新しい» を返すのが肝**。古い方を返すと、会話が先へ進んだ後に昔の答えが
   * 蘇ってくる。切れた直後にはそれより新しい ask は存在しないので、新しい方で必ず当たる。
   */
  async findUndeliveredAsk(sessionKey: string): Promise<Ask | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM asks
          WHERE session_key = ? AND delivered_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(sessionKey)
      .first<AskRow>();
    return row ? toAsk(row) : null;
  }

  /** 返せた印。**Claude へ書き出せた時点で立てる** (書けたことが唯一の手掛かりなので)。 */
  async markAskDelivered(askId: string): Promise<void> {
    await this.db
      .prepare("UPDATE asks SET delivered_at = ? WHERE ask_id = ? AND delivered_at IS NULL")
      .bind(nowIso(), askId)
      .run();
  }

  /** そのセッションが «まだ答えを貰えていない質問»。新しさは見ない (見るのは呼ぶ側)。 */
  async findOpenAsk(sessionKey: string): Promise<Ask | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM asks WHERE session_key = ? AND answer IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .bind(sessionKey)
      .first<AskRow>();
    return row ? toAsk(row) : null;
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

  /* ---- inbox (作業中に書かれた文の置き場) ---- */

  async queueMessage(input: {
    sessionKey: string;
    threadId: string;
    authorId: string;
    messageId: string | null;
    body: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO inbox (session_key, thread_id, author_id, message_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.sessionKey, input.threadId, input.authorId, input.messageId, input.body, nowIso())
      .run();
  }

  /**
   * 溜まっている文をまとめて **読む**。印は立てない。
   *
   * **1 つに畳んで返す**。Claude が聞きに来るのは 1 回で、答えられるのも 1 回だから
   * (「A して」「あと B も」を別々に渡す口が無い)。書いた順に改行で繋ぐ。
   *
   * 印を立てるのは渡し切った後 (`markQueuedTaken`)。ここで立ててしまうと、渡す処理が
   * 失敗したときに文が宙に浮いて **誰にも届かないまま消える**。
   */
  async peekQueued(sessionKey: string): Promise<QueuedBatch | null> {
    const rows = await this.db
      .prepare(
        `SELECT id, author_id, message_id, body FROM inbox
          WHERE session_key = ? AND taken_at IS NULL ORDER BY id`,
      )
      .bind(sessionKey)
      .all<{ id: number; author_id: string; message_id: string | null; body: string }>();

    const results = rows.results ?? [];
    const first = results[0];
    if (first === undefined) return null;

    return {
      text: results.map((row) => row.body).join("\n"),
      authorId: first.author_id,
      messageIds: results
        .map((row) => row.message_id)
        .filter((id): id is string => id !== null && id !== ""),
      ids: results.map((row) => row.id),
    };
  }

  /**
   * 渡し切った文に «渡した» 印を立てる。**peek した行だけ**を名指しする —
   * 「未処理を全部」にすると、peek と mark の間に届いた文まで飲み込む。
   */
  async markQueuedTaken(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    await this.db
      .prepare(`UPDATE inbox SET taken_at = ? WHERE id IN (${placeholders}) AND taken_at IS NULL`)
      .bind(nowIso(), ...ids)
      .run();
  }

  /* ---- plans ---- */

  /**
   * 計画の台帳を引くか、無ければ作る。**呼ぶ側は `plan_id` を知らない** —
   * 知っているのは «どのスレッドの、何という名前か» だけで、id の発行と再利用はここだけの話。
   *
   * これが «引くか作る» でないと、同じ計画を直して出し直すたびに URL が変わり、
   * スレッドに貼ったリンクが古い方を指し続ける。
   */
  async upsertPlan(input: { scope: string; slug: string; sessionKey: string }): Promise<Plan> {
    const at = nowIso();
    const existing = await this.db
      .prepare("SELECT * FROM plans WHERE scope = ? AND slug = ?")
      .bind(input.scope, input.slug)
      .first<PlanRow>();
    if (existing) {
      await this.db
        .prepare("UPDATE plans SET session_key = ?, updated_at = ? WHERE plan_id = ?")
        .bind(input.sessionKey, at, existing.plan_id)
        .run();
      return { ...toPlan(existing), sessionKey: input.sessionKey, updatedAt: at };
    }
    const planId = newPlanId();
    await this.db
      .prepare(
        `INSERT INTO plans (plan_id, scope, slug, session_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(planId, input.scope, input.slug, input.sessionKey, at, at)
      .run();
    return {
      planId,
      scope: input.scope,
      slug: input.slug,
      sessionKey: input.sessionKey,
      createdAt: at,
      updatedAt: at,
    };
  }

  async getPlan(planId: string): Promise<Plan | null> {
    const row = await this.db
      .prepare("SELECT * FROM plans WHERE plan_id = ?")
      .bind(planId)
      .first<PlanRow>();
    return row ? toPlan(row) : null;
  }

  /** 置き終わりの印。読む側が «最終更新» として出す。 */
  async touchPlan(planId: string): Promise<void> {
    await this.db
      .prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?")
      .bind(nowIso(), planId)
      .run();
  }

  /* ---- events ---- */

  async addEvent(sessionKey: string, kind: string, body: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO events (session_key, kind, body, created_at) VALUES (?, ?, ?, ?)")
      .bind(sessionKey, kind, body, nowIso())
      .run();
  }
}
