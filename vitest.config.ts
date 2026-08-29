import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// 実行前に migrations を読み、setup で毎回まっさらな D1 に流す。
// 「一時 DB に張ってから CRUD を確かめる」を素で書けるようにするため。
const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineWorkersConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DISCORD_PUBLIC_KEY: "00",
            DISCORD_APPLICATION_ID: "app-1",
            DISCORD_BOT_TOKEN: "bot-token",
            OWNER_DISCORD_USER_ID: "owner-1",
            KANATA_TOKEN: "test-token",
            PROJECTS_JSON: JSON.stringify([
              {
                name: "demo",
                repoUrl: "https://github.com/example/demo",
                fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire",
                fireToken: "sk-ant-oat01-test",
              },
            ]),
            // 握りの上限。1.5 秒あれば «回答が入る» 側は即座に、«握り切れた» 側も現実的な時間で終わる。
            ASK_HOLD_MS: "1500",
            ASK_POLL_MS: "10",
            ASK_PING_MS: "50",
          },
        },
      },
    },
  },
});
