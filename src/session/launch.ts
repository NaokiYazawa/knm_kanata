import { fireRoutine } from "../anthropic/routines";
import { Repo } from "../db/repo";
import { noticeMessage } from "../discord/components";
import { DiscordRest } from "../discord/rest";
import { newSessionKey } from "../domain/ids";
import type { Project } from "../domain/projects";
import { buildFireText } from "../domain/prompt";
import type { Env } from "../env";

/**
 * セッションを 1 件起こす。**入口が 2 つある**ので共有する:
 *
 * - `/claude` … スレッドをこれから作る (作った先へ出す)
 * - 素の文 … 終わったスレッドに書き足された (そのスレッドへ出す)
 *
 * 起動の «台帳へ書く → routine を叩く → 結果を出す» の順序と失敗時の後始末は 1 つにしておく。
 * 片方だけ直すと «起動したのに台帳が queued のまま» のような、後から追えない状態が生まれる。
 */

/** routine を叩き、結果をスレッドへ出す。台帳への記録もここで閉じる。 */
export async function fireAndAnnounce(
  env: Env,
  input: {
    sessionKey: string;
    project: Project;
    prompt: string;
    /** 出す先。スレッドが作れていなければ元のチャンネル。 */
    target: string;
  },
): Promise<boolean> {
  const repo = new Repo(env.DB);
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);

  const fired = await fireRoutine(input.project, buildFireText(input.sessionKey, input.prompt));
  if (!fired.ok) {
    await repo.setStatus(input.sessionKey, "failed");
    await repo.addEvent(input.sessionKey, "error", fired.detail);
    await rest.postMessage(
      input.target,
      noticeMessage("⛔ 起動に失敗しました", fired.detail, true),
    );
    return false;
  }

  await repo.attachCloudSession(input.sessionKey, fired.sessionId, fired.sessionUrl);
  await repo.addEvent(input.sessionKey, "progress", `セッション開始: ${fired.sessionUrl}`);
  await rest.postMessage(
    input.target,
    noticeMessage(
      "▶️ 実行中",
      `[セッションを開く](${fired.sessionUrl})\n\`${input.sessionKey}\``,
      false,
    ),
  );
  return true;
}

/**
 * 既にあるスレッドの中で新しく起こす。前の会話の記憶は引き継がない (別のセッションなので)。
 * その事実は呼び出し側がスレッドへ 1 行出す — ここは «起こす» だけを担う。
 *
 * **起動できたかを返す。** 呼び出し側は «預かっていた文を渡し終えた» 印をこれで決める
 * (起動に失敗したのに印を立てると、その文は誰にも届かないまま消える)。
 */
export async function startInThread(
  env: Env,
  input: {
    threadId: string;
    channelId: string;
    project: Project;
    prompt: string;
    requesterId: string;
  },
): Promise<{ sessionKey: string; fired: boolean }> {
  const repo = new Repo(env.DB);
  const sessionKey = newSessionKey();
  await repo.createSession({
    sessionKey,
    project: input.project.name,
    prompt: input.prompt,
    requesterId: input.requesterId,
    channelId: input.channelId,
  });
  await repo.attachThread(sessionKey, input.threadId);
  const fired = await fireAndAnnounce(env, {
    sessionKey,
    project: input.project,
    prompt: input.prompt,
    target: input.threadId,
  });
  return { sessionKey, fired };
}
