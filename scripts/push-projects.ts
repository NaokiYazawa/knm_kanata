/**
 * `.env.local` の `PROJECTS_JSON` を本番の secret へ流す。
 * `pnpm run projects:push -- --profile linto`
 *
 * ## なぜこの口が要るか
 *
 * secret は書き込み専用で読み出せない (`wrangler secret list` は名前しか返さない)。
 * そして `wrangler secret put` は値を丸ごと置き換える。つまりプロジェクトを 1 つ足すとき、手元に全文が無ければ既にある分が消える。
 * 消えて痛いのは routine の fire トークンで、これも «一度しか表示されない» ので、失うと web UI で発行し直す (= 前のを失効させる) しかない。
 *
 * だから **`.env.local` を正本にする**。ここを直して push する、という 1 本道にしておけば、「今の値を思い出す」作業が発生しない。
 * `.env.local` は `.gitignore` 済みで、`commands:register` も同じファイルを読んでいる。
 *
 * トークンを引数やターミナルに貼らないのも狙いの 1 つ (シェルの履歴に残さない)。
 *
 * **値は `.env.local` から直に読む。環境変数は見ない。** `PROJECTS_JSON=… node scripts/…` と
 * 手で流し込めてしまうと、動作確認のつもりの 1 行が本番を上書きできる。実際にそれで本番の
 * secret を壊した (2026-08-29)。正本は 1 つ、経路も 1 つにしておく。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { isProjectsProblem, parseProjects } from "../src/domain/projects.ts";

const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));

let raw: string | undefined;
try {
  raw = parseEnv(readFileSync(envPath, "utf8")).PROJECTS_JSON;
} catch {
  console.error(`${envPath} を読めません。`);
  process.exit(1);
}

if (!raw) {
  console.error("PROJECTS_JSON が .env.local にありません。");
  console.error("本番には設定済みでも、secret は読み出せないので手元に正本を作る必要があります。");
  process.exit(1);
}

// 本体と同じ検証を通す。壊れた値を push すると `/claude` が丸ごと止まるので、その前に落とす。
const projects = parseProjects(raw);
if (isProjectsProblem(projects)) {
  console.error(`PROJECTS_JSON を読めません: ${projects.message}`);
  process.exit(1);
}

// トークンは出さない。何を送るかだけ見せる。
console.log(`${projects.length} 件を送ります:`);
for (const project of projects) {
  const channel = project.channelId ?? "(チャンネル未設定)";
  console.log(`  - ${project.name}  ${channel}  ${project.repoUrl}`);
}

const child = spawn(
  "wrangler",
  ["secret", "put", "PROJECTS_JSON", ...process.argv.slice(2)],
  // 値は stdin で渡す (引数にすると `ps` とシェルの履歴に載る)。
  { stdio: ["pipe", "inherit", "inherit"] },
);
child.stdin.write(raw);
child.stdin.end();
child.on("exit", (code) => process.exit(code ?? 1));
