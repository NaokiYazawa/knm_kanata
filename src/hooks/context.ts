import { Repo } from "../db/repo";
import { isContextProblem, totalContextUsage } from "../domain/context";
import { isSessionKey } from "../domain/ids";
import type { Env } from "../env";

/**
 * cloud session の hook からのコンテキスト使用量の通報。
 *
 * **Claude Code には «いまどれだけコンテキストを使ったか» を外へ出す口が無い。** どの hook の
 * 入力にも入っておらず、ステータスラインは対話 UI 専用でクラウドでは動かない。残る唯一の
 * 出口が転写ログの `message.usage` なので、hook 側で読んでここへ POST してもらう。
 *
 * 呼ばれるのは 2 か所 (`repo-template/.claude/settings.json`):
 *
 * - `PreToolUse` (kanata のツールを呼ぶ直前) … **表示する直前の値**が欲しいので
 * - `Stop` (ターンの終わり) … 質問を出さずに長く働いたときも値を保つため
 *
 * 失敗しても Claude 側には何も返さない (hook は必ず exit 0 する)。ここが落ちても本題は進む。
 */

type ContextBody = {
  session_key?: unknown;
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
};

export async function handleContextHook(request: Request, env: Env): Promise<Response> {
  let body: ContextBody;
  try {
    body = (await request.json()) as ContextBody;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const sessionKey = typeof body.session_key === "string" ? body.session_key.trim() : "";
  if (!isSessionKey(sessionKey)) {
    return Response.json({ ok: false, reason: "session_key が読めません" });
  }

  const usage = totalContextUsage(body);
  if (isContextProblem(usage)) return Response.json({ ok: false, reason: usage.message });

  // 台帳に無いセッション (別リポジトリ・古い実行) は静かに落とす。
  const written = await new Repo(env.DB).saveContextUsage(sessionKey, usage);
  return Response.json({ ok: written, used_tokens: usage.usedTokens });
}
