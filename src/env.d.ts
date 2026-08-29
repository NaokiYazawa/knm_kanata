export type Env = {
  DB: D1Database;

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

  /** 任意。ask_human が 1 回の呼び出しで待つ長さ (ms)。既定 75000。テスト用に短くする。 */
  ASK_WAIT_BUDGET_MS?: string;
  /** 任意。回答を見に行く間隔 (ms)。既定 2000。 */
  ASK_POLL_MS?: string;
};
