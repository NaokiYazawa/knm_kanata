import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../env";

// `cloudflare:test` の `env` の型。本体の Env に、テスト専用の binding を足す。
declare module "cloudflare:test" {
  interface ProvidedEnv extends AppEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}
