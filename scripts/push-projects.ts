/**
 * `projects.json` を本番の secret (`PROJECTS_JSON`) へ送る。
 *
 *   pnpm run projects:push -- --profile linto
 *   pnpm run projects:push -- --dry-run     # 送らずに、送る値だけ見る
 *
 * 正本をなぜ手元に持つのかは `load-projects.ts` に書いてある。ここは «見せて、渡す» だけ。
 *
 * **`--dry-run` はこのスクリプトを試すための唯一の安全な口。** 偽の `wrangler` を PATH の先頭に
 * 置いて確かめようとすると、本物が走って本番の secret を上書きする (2 回やった)。
 * 本番へ書くコマンドを影武者で試そうとしないこと。
 */

import { spawn } from "node:child_process";
import { describe, loadProjects } from "./load-projects.ts";

let loaded: ReturnType<typeof loadProjects>;
try {
  loaded = loadProjects();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// トークンは出さない。何を送るかだけ。
console.log(`${loaded.projects.length} 件を${dryRun ? "送るところ" : "送ります"}:`);
console.log(describe(loaded.projects));

if (dryRun) {
  console.log(`\n送る値: ${loaded.value.length} 文字の 1 行 JSON (中身は出さない)`);
  console.log("--dry-run なので wrangler は呼びません。");
  process.exit(0);
}

const child = spawn("wrangler", ["secret", "put", "PROJECTS_JSON", ...args], {
  // 値は stdin で渡す (引数にすると `ps` とシェルの履歴に載る)。
  stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.write(loaded.value);
child.stdin.end();
child.on("exit", (code) => process.exit(code ?? 1));
