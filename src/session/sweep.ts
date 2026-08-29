import { Repo } from "../db/repo";
import { noticeMessage } from "../discord/components";
import { DiscordRest } from "../discord/rest";
import type { Env } from "../env";

/**
 * **起動しそこねたセッションを畳む。** 5 分 cron から呼ばれる。
 *
 * ## なぜ要るか
 *
 * `/claude` は 3 秒以内に «保留» を返し、残り (スレッド作成 → routine 起動) を `waitUntil`
 * へ逃がす。ところが `waitUntil` は **応答から 30 秒**で打ち切られる (Workers の仕様)。
 * routine の起動が遅れてそこで切られると、台帳には `queued` の行だけが残る。
 *
 * そして `domain/inbound.ts` は `queued` を «起動直後» とみなして **溜める** 側に倒す。
 * つまり以後そのスレッドに書いた文は、6 時間ぶん全部そこへ吸い込まれ、誰も読まない。
 * «書いたのに何も起きない» という、いちばん気付きにくい壊れ方になる。
 *
 * ## なぜ «起こし直す» ではなく «失敗にする» のか
 *
 * ここで勝手に routine を起こすと、**実は起動できていた場合に 2 本目が立つ** (fire は
 * 冪等ではなく、呼べば必ず新しいセッションが増える)。取り返せない方へ倒さない。
 * `failed` にすれば、次にその人が何か書いた時点で `restart` として起こし直され、
 * 溜まっていた文も一緒に渡る。判断は人の «次の 1 行» に預ける。
 */

/** これを過ぎても `queued` のままなら、起動は失敗したものとみなす。 */
export const STUCK_QUEUED_MS = 10 * 60_000;

/** 1 回の cron で畳む上限。溜まっていても cron は 5 分ごとに来るので急がない。 */
const SWEEP_LIMIT = 20;

export async function sweepStuckSessions(env: Env, now: number = Date.now()): Promise<number> {
  const repo = new Repo(env.DB);
  const stuck = await repo.listStuckQueued(
    new Date(now - STUCK_QUEUED_MS).toISOString(),
    SWEEP_LIMIT,
  );
  if (stuck.length === 0) return 0;

  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  for (const session of stuck) {
    await repo.setStatus(session.sessionKey, "failed");
    await repo.addEvent(session.sessionKey, "error", "起動が完了しないまま時間切れになりました");
    await rest.postMessage(
      session.threadId ?? session.channelId,
      noticeMessage(
        "⛔ 起動を確認できませんでした",
        "セッションが立ち上がったか分からないまま時間切れになりました。**もう一度書けば起こし直します**（預かっている文があれば一緒に渡します）。",
        true,
      ),
    );
  }
  return stuck.length;
}
