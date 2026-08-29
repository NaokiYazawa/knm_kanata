import { Repo } from "../db/repo";
import { decideInbound } from "../domain/inbound";
import { findProject, isProjectsProblem, parseProjects } from "../domain/projects";
import type { Env } from "../env";
import { startInThread } from "../session/launch";
import { askAnsweredMessage, noticeMessage } from "./components";
import { DiscordRest } from "./rest";

/**
 * スレッドに届いた 1 文を実際に処理する層。**判断は `domain/inbound.ts` が持つ**ので、
 * ここは決まったことを Discord と D1 に反映するだけ。
 *
 * 入口は 2 つあり、どちらも同じ判断を通す:
 *
 * - Gateway が拾った素の文 (`gateway/gateway.do.ts`)
 * - kanata が知っているスレッドの中で叩かれた `/claude` (`discord/interactions.ts`)
 *
 * 同じスレッドで同じ文を書いたのに、コマンドか素の文かで結果が変わってはいけない。
 */

/** 預かった印。チャットに «受け取りました» と 1 行足さずに状態を見せる。 */
const MARK_QUEUED = "👀";
/** Claude へ渡した印。預かった印と入れ替える。 */
const MARK_DELIVERED = "✅";

export type InboundOutcome =
  | Readonly<{ kind: "ignored"; reason: string }>
  | Readonly<{ kind: "answered"; askId: string }>
  | Readonly<{ kind: "queued" }>
  | Readonly<{ kind: "restarted"; sessionKey: string }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type InboundInput = Readonly<{
  threadId: string;
  /** Discord のメッセージ。`/claude` から来たときは印を付ける相手が居ないので null。 */
  messageId: string | null;
  authorId: string;
  authorIsBot: boolean;
  text: string;
}>;

export async function applyInbound(env: Env, input: InboundInput): Promise<InboundOutcome> {
  const repo = new Repo(env.DB);
  const session = await repo.findSessionByThread(input.threadId);
  const openAsk = session ? await repo.findOpenAsk(session.sessionKey) : null;

  const decision = decideInbound({
    authorId: input.authorId,
    authorIsBot: input.authorIsBot,
    text: input.text,
    ownerId: env.OWNER_DISCORD_USER_ID.trim(),
    session: session ? { status: session.status, updatedAt: session.updatedAt } : null,
    hasOpenAsk: openAsk !== null,
    now: Date.now(),
  });

  if (decision.kind === "ignore") return { kind: "ignored", reason: decision.reason };
  // decide が ignore 以外を返した時点で session は必ずある (判断側の不変条件)。
  if (!session) return { kind: "ignored", reason: "このスレッドにセッションが無い" };

  const text = input.text.trim();
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);

  if (decision.kind === "answer" && openAsk) {
    const written = await repo.answerAsk(openAsk.askId, text, input.authorId);
    if (written) {
      // 押し口を消す。ボタンが残ると、もう効かないものを押せてしまう。
      if (openAsk.messageId) {
        await rest.editMessage(
          input.threadId,
          openAsk.messageId,
          askAnsweredMessage(openAsk, text),
        );
      }
      await repo.addEvent(session.sessionKey, "progress", `${openAsk.askId} に回答: ${text}`);
      if (session.status === "waiting") await repo.setStatus(session.sessionKey, "running");
      return { kind: "answered", askId: openAsk.askId };
    }
    // ボタンと素の文が同時に入った。書いた文を捨てず、次の問いに回す。
    return queue(repo, rest, session.sessionKey, input, text);
  }

  if (decision.kind === "queue") {
    return queue(repo, rest, session.sessionKey, input, text);
  }

  /* restart — 前のセッションは終わっている / 落ちている。 */

  const projects = parseProjects(env.PROJECTS_JSON);
  if (isProjectsProblem(projects)) return { kind: "failed", reason: projects.message };
  const project = findProject(projects, session.project);
  if (!project) {
    return { kind: "failed", reason: `プロジェクト «${session.project}» が設定にありません` };
  }

  // 溜まっていたぶんも一緒に渡す。ここで捨てると «預かったのに何も起きなかった» になる。
  // **印を立てるのは起動できてから** (先に立てると、起動に失敗した文がどこにも残らない)。
  const pending = await repo.peekQueued(session.sessionKey);
  const prompt = pending ? `${pending.text}\n${text}` : text;

  await rest.postMessage(
    input.threadId,
    noticeMessage(
      "🔁 新しいセッションを起こしました",
      "前のセッションは終わっています。**記憶は引き継ぎません。**",
      false,
    ),
  );

  const started = await startInThread(env, {
    threadId: input.threadId,
    channelId: session.channelId,
    project,
    prompt,
    requesterId: input.authorId,
  });
  if (pending && started.fired) {
    await repo.markQueuedTaken(pending.ids);
    await markDelivered(rest, input.threadId, pending.messageIds);
  }
  return { kind: "restarted", sessionKey: started.sessionKey };
}

async function queue(
  repo: Repo,
  rest: DiscordRest,
  sessionKey: string,
  input: InboundInput,
  text: string,
): Promise<InboundOutcome> {
  await repo.queueMessage({
    sessionKey,
    threadId: input.threadId,
    authorId: input.authorId,
    messageId: input.messageId,
    body: text,
  });
  if (input.messageId) await rest.addReaction(input.threadId, input.messageId, MARK_QUEUED);
  return { kind: "queued" };
}

/**
 * 預かっていた文を Claude へ渡したときの印の付け替え。
 *
 * 失敗しても本処理 (= Claude に渡すこと) は止めない — 印が出ないことより、渡らないことの方が
 * 悪い。`DiscordRest` は結果を返すだけで例外を投げないので、ここでは待つだけでよい。
 */
export async function markDelivered(
  rest: DiscordRest,
  threadId: string,
  messageIds: readonly string[],
): Promise<void> {
  for (const messageId of messageIds) {
    await rest.addReaction(threadId, messageId, MARK_DELIVERED);
    await rest.removeOwnReaction(threadId, messageId, MARK_QUEUED);
  }
}
