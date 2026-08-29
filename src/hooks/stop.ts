import { Repo } from "../db/repo";
import { noticeMessage } from "../discord/components";
import { DiscordRest } from "../discord/rest";
import { isSessionKey } from "../domain/ids";
import { elapsedLabel, nowIso } from "../domain/time";
import type { Env } from "../env";

/**
 * cloud session の Stop hook からの通報。
 *
 * これは **保険**であって主経路ではない。主経路は Claude が `report(kind:"done")` を呼ぶこと。
 * だが «呼び忘れる» ことも «途中で力尽きる» こともあるので、セッションが終わったという事実だけは
 * hook から必ず届くようにする。`report` が先に来ていたら二重に出さない。
 */

type StopBody = { session_key?: unknown; summary?: unknown };

export async function handleStopHook(request: Request, env: Env): Promise<Response> {
  let body: StopBody;
  try {
    body = (await request.json()) as StopBody;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const sessionKey = typeof body.session_key === "string" ? body.session_key.trim() : "";
  if (!isSessionKey(sessionKey)) {
    // 印が拾えなかった実行。記録だけ残して 200 を返す (hook を落とすと Claude 側に赤が出る)。
    console.warn("[stop-hook] session_key が読めませんでした");
    return Response.json({ ok: false, reason: "session_key が読めません" });
  }

  const repo = new Repo(env.DB);
  const session = await repo.getSession(sessionKey);
  if (!session) return Response.json({ ok: false, reason: "unknown session" });

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  await repo.addEvent(sessionKey, "stop_hook", summary || "(要約なし)");

  // report(done) が来ていれば、完了は既に出ている。同じことを 2 回出さない。
  if (session.status === "done") return Response.json({ ok: true, duplicated: true });

  await repo.setStatus(sessionKey, "done");
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const link = session.ccSessionUrl ? `\n[セッションを開く](${session.ccSessionUrl})` : "";
  await rest.postMessage(
    session.threadId ?? session.channelId,
    noticeMessage(
      "🏁 セッションが終了しました",
      `${summary || "完了の報告が無いまま終わりました。"}\n所要 ${elapsedLabel(session.createdAt, nowIso())}${link}`,
      false,
    ),
  );
  return Response.json({ ok: true });
}
