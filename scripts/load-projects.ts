import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isProjectsProblem, type Project, parseProjects } from "../src/domain/projects.ts";

/**
 * `projects.json` を読んで検証する。**手元の正本はこのファイル 1 つ**。
 *
 * Worker の secret は書き込み専用で読み出せない (`wrangler secret list` は名前しか返さない) のに
 * `wrangler secret put` は値を丸ごと置き換えるので、手元に全文が無いと既にある分が消える。
 * 実際に消した。だから «手元の 1 ファイルを直して送る» の 1 本道にしてある。
 *
 * `.env.local` に入れないのは、**1 行にすると読めない**から (プロジェクトが増えるほど直せなくなる)。
 * JSON ファイルなら整形したまま置ける。`.gitignore` 済み — 中に routine の fire トークンが入る。
 *
 * 環境変数からは受け取らない。`PROJECTS_JSON=… node scripts/…` と手で流し込めてしまうと、
 * 動作確認のつもりの 1 行が本番を上書きできる (これも実際にやった)。入口は 1 つに閉じる。
 */

export const PROJECTS_PATH = fileURLToPath(new URL("../projects.json", import.meta.url));

/** 読めなければ理由を添えて投げる。呼ぶ側が catch して落とす。 */
export function loadProjects(): { value: string; projects: readonly Project[] } {
  let raw: string;
  try {
    raw = readFileSync(PROJECTS_PATH, "utf8");
  } catch {
    throw new Error(
      `${PROJECTS_PATH} がありません。projects.example.json をコピーして作ってください。`,
    );
  }

  // 本体と同じ検証を通す。壊れた値を送ると `/claude` が丸ごと止まるので、その前に落とす。
  const projects = parseProjects(raw);
  if (isProjectsProblem(projects)) throw new Error(projects.message);

  // 整形は手元の都合なので、送るときは畳む。
  return { value: JSON.stringify(JSON.parse(raw)), projects };
}

/** トークンを出さずに «何を送るか» だけ見せる。 */
export function describe(projects: readonly Project[]): string {
  return projects
    .map((p) => `  - ${p.name}  ${p.channelId ?? "(チャンネル未設定)"}  ${p.repoUrl}`)
    .join("\n");
}
