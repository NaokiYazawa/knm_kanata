import { Repo } from "../db/repo";
import { MODAL_ANSWER_FIELD, parseAskAction } from "../domain/ask";
import { newSessionKey } from "../domain/ids";
import { isOwner } from "../domain/owner";
import {
  findProject,
  findProjectByChannel,
  isProjectsProblem,
  parseProjects,
} from "../domain/projects";
import type { Env } from "../env";
import { fireAndAnnounce } from "../session/launch";
import { answerModal, askAnsweredMessage, noticeMessage, startedMessage } from "./components";
import { applyInbound } from "./inbound";
import { DiscordRest, isThreadChannelType } from "./rest";

/**
 * Interactions の入口。
 *
 * **3 秒以内に一次応答を返さないと «This interaction failed» になる。** routine の起動も
 * スレッド作成も 3 秒に収まる保証が無いので、`/claude` は必ず «保留 (type 5)» を先に返し、
 * 実際の仕事は `waitUntil` に逃がす。押した人には «起動中» が即座に出る。
 */

/** `waitUntil` だけを要求する。Hono と workers-types で ExecutionContext の形が違うため。 */
type Waitable = { waitUntil(promise: Promise<unknown>): void };

const EPHEMERAL = 64;

const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2;
const TYPE_MESSAGE_COMPONENT = 3;
const TYPE_MODAL_SUBMIT = 5;

const REPLY_PONG = 1;
const REPLY_MESSAGE = 4;
const REPLY_DEFERRED_MESSAGE = 5;
const REPLY_UPDATE_MESSAGE = 7;

type InteractionOption = { name: string; value?: unknown };

type Interaction = {
  type: number;
  token: string;
  channel_id?: string;
  /** スレッドで叩かれたとき `id` はスレッド、`parent_id` が元のチャンネル。 */
  channel?: { id?: string; type?: number; parent_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
  message?: { id?: string; channel_id?: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: InteractionOption[];
    components?: { components?: { custom_id?: string; value?: string }[] }[];
  };
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function ephemeral(text: string): Response {
  return json({ type: REPLY_MESSAGE, data: { content: text, flags: EPHEMERAL } });
}

function actorId(interaction: Interaction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function optionString(interaction: Interaction, name: string): string | null {
  const option = interaction.data?.options?.find((o) => o.name === name);
  return typeof option?.value === "string" && option.value.trim() !== ""
    ? option.value.trim()
    : null;
}

export async function handleInteraction(
  interaction: Interaction,
  env: Env,
  ctx: Waitable,
): Promise<Response> {
  if (interaction.type === TYPE_PING) return json({ type: REPLY_PONG });

  const userId = actorId(interaction);
  if (userId === null || !isOwner(env.OWNER_DISCORD_USER_ID, userId)) {
    // 押した本人にだけ見える返信なので、本人の ID を添える。
    // これが無いと «設定した ID が違う» と «そもそも別人» を切り分けられない。
    return ephemeral(
      `この bot は個人用です。(あなたの Discord ユーザー ID: ${userId ?? "取得できませんでした"})`,
    );
  }

  if (interaction.type === TYPE_APPLICATION_COMMAND) {
    return handleCommand(interaction, env, ctx, userId);
  }
  if (interaction.type === TYPE_MESSAGE_COMPONENT) {
    return handleComponent(interaction, env, ctx, userId);
  }
  if (interaction.type === TYPE_MODAL_SUBMIT) {
    return handleModalSubmit(interaction, env, ctx, userId);
  }
  return ephemeral("この操作には対応していません。");
}

/* ---- /claude ---- */

async function handleCommand(
  interaction: Interaction,
  env: Env,
  ctx: Waitable,
  userId: string,
): Promise<Response> {
  if (interaction.data?.name !== "claude") return ephemeral("知らないコマンドです。");

  const task = optionString(interaction, "task");
  if (!task) return ephemeral("指示 (task) を入れてください。");

  const channelId = interaction.channel?.id ?? interaction.channel_id;
  if (!channelId) return ephemeral("チャンネルが分かりませんでした。");

  // kanata が知っているスレッドの中なら、**素の文とまったく同じ扱い**にする
  // (回答 / 溜める / 起こし直す)。同じスレッドに同じ文を書いたのに、コマンドか素の文かで
  // 結果が変わってはいけない。判断は `domain/inbound.ts` が 1 つだけ持つ。
  const known = await new Repo(env.DB).findSessionByThread(channelId);
  if (known) {
    ctx.waitUntil(continueInThread(env, interaction.token, channelId, task, userId));
    return json({ type: REPLY_DEFERRED_MESSAGE });
  }

  const projects = parseProjects(env.PROJECTS_JSON);
  if (isProjectsProblem(projects)) return ephemeral(`設定を読めません: ${projects.message}`);

  // どのプロジェクトかは 3 段で決める。**チャンネルが 2 番目**なのが肝で、
  // «そのチャンネルはそのプロジェクト» と決めておけば毎回名前を書かなくてよくなる。
  // スレッドの中で叩かれたら `channel.id` はスレッドなので、親チャンネルでも照合する。
  const requested = optionString(interaction, "project");
  const project = requested
    ? findProject(projects, requested)
    : (findProjectByChannel(projects, [
        interaction.channel?.parent_id,
        interaction.channel?.id ?? interaction.channel_id,
      ]) ?? (projects.length === 1 ? projects[0] : null));
  if (!project) {
    const names = projects.map((p) => p.name).join(" / ");
    return ephemeral(
      requested
        ? `プロジェクト «${requested}» は登録されていません。使えるのは: ${names}`
        : `このチャンネルに結び付いたプロジェクトがありません。project を指定してください: ${names}`,
    );
  }

  // ここから先は 3 秒に収まらない。先に «受け付けました» を返す。
  ctx.waitUntil(
    startSession({
      env,
      interactionToken: interaction.token,
      channelId,
      // スレッドの中で叩かれたらそのスレッドを使う。スレッドの中にスレッドは作れない。
      alreadyInThread: isThreadChannelType(interaction.channel?.type),
      project: project.name,
      prompt: task,
      requesterId: userId,
    }),
  );
  return json({ type: REPLY_DEFERRED_MESSAGE });
}

async function startSession(input: {
  env: Env;
  interactionToken: string;
  channelId: string;
  alreadyInThread: boolean;
  project: string;
  prompt: string;
  requesterId: string;
}): Promise<void> {
  const { env } = input;
  const repo = new Repo(env.DB);
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);

  const sessionKey = newSessionKey();
  await repo.createSession({
    sessionKey,
    project: input.project,
    prompt: input.prompt,
    requesterId: input.requesterId,
    channelId: input.channelId,
  });

  const original = await rest.editOriginalResponse(
    input.interactionToken,
    startedMessage({ project: input.project, prompt: input.prompt, sessionKey }),
  );

  // 会話の置き場を決める。スレッドが作れなければ元のチャンネルへ出す (通知が消えるよりまし)。
  let threadId = input.alreadyInThread ? input.channelId : null;
  if (!threadId && original.ok) {
    const created = await rest.createThreadFromMessage(
      original.value.channel_id,
      original.value.id,
      `${input.project}: ${input.prompt}`.slice(0, 100),
    );
    if (created.ok) threadId = created.value.id;
  }
  await repo.attachThread(sessionKey, threadId ?? input.channelId);

  const projects = parseProjects(env.PROJECTS_JSON);
  const project = isProjectsProblem(projects) ? null : findProject(projects, input.project);
  if (!project) {
    await repo.setStatus(sessionKey, "failed");
    await repo.addEvent(sessionKey, "error", "起動時にプロジェクト設定を引けませんでした");
    return;
  }

  await fireAndAnnounce(env, {
    sessionKey,
    project,
    prompt: input.prompt,
    target: threadId ?? input.channelId,
  });
}

/**
 * kanata が知っているスレッドの中で `/claude` が叩かれたとき。
 *
 * **先に本人の発言として出してから**中身を進める。素の文なら Discord に本人の発言が既に
 * 見えているが、コマンドでは見えないので、ここで echo しないと «誰が何を言ったのか»
 * 分からないまま kanata の返事だけが並ぶ。
 */
async function continueInThread(
  env: Env,
  interactionToken: string,
  threadId: string,
  text: string,
  userId: string,
): Promise<void> {
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  await rest.editOriginalResponse(interactionToken, {
    content: text.slice(0, 2000),
    allowed_mentions: { parse: [] },
  });

  const outcome = await applyInbound(env, {
    threadId,
    // 印 (リアクション) を付ける相手が居ない。コマンドの応答自体は bot の投稿なので。
    messageId: null,
    authorId: userId,
    authorIsBot: false,
    text,
  });

  if (outcome.kind === "queued") {
    await rest.editOriginalResponse(interactionToken, {
      content:
        `${text.slice(0, 1900)}\n-# 預かりました。Claude が次に聞きに来たときに渡します`.slice(
          0,
          2000,
        ),
      allowed_mentions: { parse: [] },
    });
    return;
  }
  if (outcome.kind === "ignored" || outcome.kind === "failed") {
    // 黙って消えるのが一番困る。何もしなかった理由をその場に残す。
    await rest.editOriginalResponse(
      interactionToken,
      noticeMessage("⛔ 進みませんでした", outcome.reason, true),
    );
  }
}

/* ---- ボタン ---- */

async function handleComponent(
  interaction: Interaction,
  env: Env,
  ctx: Waitable,
  userId: string,
): Promise<Response> {
  const action = parseAskAction(interaction.data?.custom_id ?? "");
  if (!action) return ephemeral("この操作には対応していません。");

  const repo = new Repo(env.DB);
  const ask = await repo.getAsk(action.askId);
  if (!ask) return ephemeral("この質問は見つかりませんでした。");
  if (ask.answer !== null) return ephemeral(`もう «${ask.answer}» と回答済みです。`);

  if (action.kind === "free") return json(answerModal(ask));
  if (action.kind !== "pick") return ephemeral("この操作には対応していません。");

  const option = ask.options[action.index];
  if (option === undefined) return ephemeral("この選択肢は見つかりませんでした。");

  const written = await repo.answerAsk(ask.askId, option, userId);
  if (!written) return ephemeral("ほぼ同時に別の回答が入りました。");

  ctx.waitUntil(afterAnswer(env, ask.sessionKey, ask.askId, option));
  return json({ type: REPLY_UPDATE_MESSAGE, data: askAnsweredMessage(ask, option, userId) });
}

async function handleModalSubmit(
  interaction: Interaction,
  env: Env,
  ctx: Waitable,
  userId: string,
): Promise<Response> {
  const action = parseAskAction(interaction.data?.custom_id ?? "");
  if (action?.kind !== "modal") return ephemeral("この操作には対応していません。");

  const field = interaction.data?.components
    ?.flatMap((row) => row.components ?? [])
    .find((component) => component.custom_id === MODAL_ANSWER_FIELD);
  const answer = field?.value?.trim() ?? "";
  if (answer === "") return ephemeral("回答が空でした。");

  const repo = new Repo(env.DB);
  const ask = await repo.getAsk(action.askId);
  if (!ask) return ephemeral("この質問は見つかりませんでした。");

  const written = await repo.answerAsk(ask.askId, answer, userId);
  if (!written) return ephemeral(`もう «${ask.answer}» と回答済みです。`);

  ctx.waitUntil(afterAnswer(env, ask.sessionKey, ask.askId, answer));
  return json({ type: REPLY_UPDATE_MESSAGE, data: askAnsweredMessage(ask, answer, userId) });
}

/** 回答が入ったら «待ち» を解いて記録に残す。Claude へは握っている ask_human の返り値として届く。 */
async function afterAnswer(
  env: Env,
  sessionKey: string,
  askId: string,
  answer: string,
): Promise<void> {
  const repo = new Repo(env.DB);
  await repo.addEvent(sessionKey, "progress", `${askId} に回答: ${answer}`);
  const session = await repo.getSession(sessionKey);
  if (session?.status === "waiting") await repo.setStatus(sessionKey, "running");
}
