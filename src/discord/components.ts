import type { Ask } from "../db/repo";
import { freeCustomId, MODAL_ANSWER_FIELD, modalCustomId, pickCustomId } from "../domain/ask";
import { toJstLabel } from "../domain/time";
import type { MessagePayload } from "./rest";

/**
 * 画面の組み立て。**生の JSON をハンドラ側に散らさない** — ボタンの custom_id もラベル上限も
 * ここ 1 箇所に閉じ込め、ハンドラは «何を出すか» だけを言う。
 */

const COLOR_ASK = 0xfee75c;
const COLOR_START = 0x5865f2;
const COLOR_PROGRESS = 0x99aab5;
const COLOR_DONE = 0x57f287;
const COLOR_ALERT = 0xed4245;

const BUTTONS_PER_ROW = 5;

/** ボタンだけを出す。地の文に混ぜない (押し口と説明が混ざると、狭い画面で見分けが付かない)。 */
function buttonRows(components: unknown[]): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < components.length; i += BUTTONS_PER_ROW) {
    rows.push({ type: 1, components: components.slice(i, i + BUTTONS_PER_ROW) });
  }
  return rows;
}

export function askMessage(ask: Ask): MessagePayload {
  const buttons: unknown[] = ask.options.map((option, index) => ({
    type: 2,
    style: 1,
    label: option,
    custom_id: pickCustomId(ask.askId, index),
  }));
  if (ask.allowFreeText) {
    buttons.push({
      type: 2,
      style: 2,
      label: "✍️ 自由に書く",
      custom_id: freeCustomId(ask.askId),
    });
  }

  return {
    embeds: [
      {
        color: COLOR_ASK,
        title: "❓ 確認したいことがあります",
        description: ask.question,
        footer: { text: `${ask.askId} · ${toJstLabel(ask.createdAt)}` },
      },
    ],
    components: buttonRows(buttons),
  };
}

/** 回答後の姿。ボタンを消して «誰が何と答えたか» を残す (押せる口が残ると二度押しを誘う)。 */
export function askAnsweredMessage(ask: Ask, answer: string, answeredBy: string): MessagePayload {
  return {
    embeds: [
      {
        color: COLOR_PROGRESS,
        title: "✅ 回答しました",
        description: ask.question,
        fields: [{ name: "回答", value: answer.slice(0, 1024) }],
        footer: { text: `${ask.askId} · <@${answeredBy}>` },
      },
    ],
    components: [],
  };
}

export function answerModal(ask: Ask): unknown {
  return {
    type: 9,
    data: {
      custom_id: modalCustomId(ask.askId),
      title: "回答を書く",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: MODAL_ANSWER_FIELD,
              style: 2,
              label: "回答",
              // 質問文をそのまま placeholder に置くと 100 字上限で切れるので短く畳む。
              placeholder: ask.question.slice(0, 100),
              required: true,
              max_length: 4000,
            },
          ],
        },
      ],
    },
  };
}

export function startedMessage(input: {
  project: string;
  prompt: string;
  sessionKey: string;
}): MessagePayload {
  return {
    embeds: [
      {
        color: COLOR_START,
        title: "🚀 クラウドセッションを起動しました",
        description: input.prompt.slice(0, 2000),
        fields: [{ name: "プロジェクト", value: input.project, inline: true }],
        footer: { text: input.sessionKey },
      },
    ],
  };
}

export function reportMessage(kind: string, text: string): MessagePayload {
  const preset =
    kind === "done"
      ? { color: COLOR_DONE, title: "✅ 完了" }
      : kind === "blocked"
        ? { color: COLOR_ALERT, title: "⛔ 進めません" }
        : { color: COLOR_PROGRESS, title: "… 進行中" };

  return {
    embeds: [{ ...preset, description: text.slice(0, 4000) }],
    // 通知本文に @ が混ざっても誰も呼び出さない。
    allowed_mentions: { parse: [] },
  };
}

export function noticeMessage(title: string, text: string, alert: boolean): MessagePayload {
  return {
    embeds: [
      {
        color: alert ? COLOR_ALERT : COLOR_PROGRESS,
        title,
        description: text.slice(0, 4000),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
