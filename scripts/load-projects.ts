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

/**
 * トークンが本当に通るかを、**セッションを作らずに**確かめる。
 *
 * fire は上限 (65,536 文字) を超える `text` を **認証の後で** 弾く。だから故意に長い text を
 * 送れば、`400 invalid_request_error` = 認証は通った / `401 authentication_error` = 通っていない、
 * と切り分けられる。どちらでもセッションは作られないので実行回数を消費しない。
 *
 * **形を見るのではなく実際に叩く**のが肝。`sk-ant-x` のような «それらしい» 置き換え文字列は
 * 形の検査をすり抜ける。実際にすり抜けて本番へ送られ、`/claude` が 401 で落ちた (2026-08-29)。
 */
export async function checkToken(
  project: Project,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const overLimit = "x".repeat(70_000);
  let response: Response;
  try {
    response = await fetch(project.fireUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${project.fireToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: overLimit }),
    });
  } catch (error) {
    return { ok: false, status: 0, detail: `届きませんでした: ${String(error)}` };
  }

  if (response.status === 401) return { ok: false, status: 401, detail: "トークンが通りません" };
  if (response.status === 404)
    return { ok: false, status: 404, detail: "fireUrl の routine がありません" };
  // 400 は «長すぎる» を弾かれただけ = 認証は通っている。429 などは判定できないので通す。
  return { ok: true, status: response.status, detail: "" };
}
