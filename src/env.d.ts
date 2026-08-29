export type Env = {
  DB: D1Database;

  /** Discord Gateway への常時接続を持つ DO。`idFromName("main")` の 1 つだけを使う。 */
  GATEWAY: DurableObjectNamespace;

  /** Discord アプリの Public Key (Interactions の署名検証)。 */
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  /** secret。 */
  DISCORD_BOT_TOKEN: string;
  /** この 1 人だけが操作できる (個人用なので fail-closed の allowlist は 1 件)。 */
  OWNER_DISCORD_USER_ID: string;

  /** secret。`[{name, repoUrl, fireUrl, fireToken}]` の JSON。 */
  PROJECTS_JSON: string;

  /** secret。cloud session 側 (MCP / hook) から叩くときの Bearer。 */
  KANATA_TOKEN: string;

  /**
   * 任意。コンテキストの分母 (トークン)。既定 200,000、拡張コンテキストのモデルなら 1,000,000。
   * **転写ログからは分母が読めない**ので設定で持つ (生のトークン数も併記するのでズレても気付ける)。
   */
  CONTEXT_WINDOW_TOKENS?: string;

  /** 任意。1 回のツール呼び出しを握り続ける上限 (ms)。既定 15 分。テスト用に短くする。 */
  ASK_HOLD_MS?: string;
  /** 任意。回答を見に行く間隔 (ms)。既定 3000。 */
  ASK_POLL_MS?: string;
  /** 任意。沈黙を作らない ping の間隔 (ms)。既定 15000。エッジの限界より十分内側にする。 */
  ASK_PING_MS?: string;
};
