import type { Ask } from "../db/repo";
import { freeCustomId, MODAL_ANSWER_FIELD, modalCustomId, pickCustomId } from "../domain/ask";
import type { MessagePayload } from "./rest";

/**
 * 画面の組み立て。**生の JSON をハンドラ側に散らさない** — ボタンの custom_id もラベル上限も
 * ここ 1 箇所に閉じ込め、ハンドラは «何を出すか» だけを言う。
 */

const COLOR_START = 0x5865f2;
const COLOR_PROGRESS = 0x99aab5;
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

/** Discord のメッセージ本文の上限。 */
const MAX_CONTENT = 2000;

/**
 * Claude の発言の末尾にコンテキストの残量を添える。
 *
 * **ここに出すのは «次に何を言うか決めるまさにその場» だから**。別の場所に置くと見に行く手間が
 * 要り、見に行かなければ «気付いたら圧縮されていた» になる。過去のメッセージは当時の値のまま
 * 残るので、伸び方もそのまま履歴として読める。
 *
 * 上限に収まらないときは **本文ではなくこの行を落とす** (本題が削れる方が困る)。
 */
function withContext(content: string, contextLine: string | null): string {
  if (!contextLine) return content.slice(0, MAX_CONTENT);
  const tail = `\n${contextLine}`;
  return content.length + tail.length <= MAX_CONTENT
    ? content + tail
    : content.slice(0, MAX_CONTENT);
}

/**
 * Claude の問いかけ。**見出しも枠も付けない** — ターミナルの Claude Code がそうであるように、
 * ただ本人が喋っているように見せる。押せる口があることはボタンが示すので、
 * 「確認したいことがあります」と宣言する必要は無い。
 */
export function askMessage(ask: Ask, contextLine: string | null = null): MessagePayload {
  const buttons: unknown[] = ask.options.map((option, index) => ({
    type: 2,
    style: 2,
    label: option,
    custom_id: pickCustomId(ask.askId, index),
  }));
  if (ask.allowFreeText) {
    buttons.push({
      type: 2,
      style: 1,
      label: "✍️ 書く",
      custom_id: freeCustomId(ask.askId),
    });
  }

  return {
    content: withContext(ask.question, contextLine),
    components: buttonRows(buttons),
    allowed_mentions: { parse: [] },
  };
}

/**
 * 回答後の姿。ボタンだけを消し、選んだものを小さく添える (押せる口が残ると二度押しを誘う)。
 * 自由記述での回答は本人の発言として別に見えているので、ここでは控えめに出す。
 */
export function askAnsweredMessage(ask: Ask, answer: string, _answeredBy: string): MessagePayload {
  const head = ask.question.slice(0, 1700);
  const tail = `\n-# → ${answer.replace(/\s+/g, " ")}`;
  return {
    content: (head + tail).slice(0, MAX_CONTENT),
    components: [],
    allowed_mentions: { parse: [] },
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

/**
 * 起動の知らせ。**触れるリポジトリを添える**のは、それがこのセッションの «できることの境界»
 * だから (実測: routine の sources に無いリポジトリは clone も push もできない)。
 * 設定に書いていなければ黙って省く。
 */
export function startedMessage(input: {
  project: string;
  repos?: readonly string[];
  prompt: string;
  sessionKey: string;
}): MessagePayload {
  const fields: unknown[] = [{ name: "プロジェクト", value: input.project, inline: true }];
  if (input.repos && input.repos.length > 0) {
    fields.push({ name: "リポジトリ", value: input.repos.join("\n").slice(0, 1024) });
  }
  return {
    embeds: [
      {
        color: COLOR_START,
        title: "🚀 クラウドセッションを起動しました",
        description: input.prompt.slice(0, 2000),
        fields,
        footer: { text: input.sessionKey },
      },
    ],
  };
}

/**
 * Claude からの報告。progress は **地の文**で出す (これも本人の発言なので枠を付けない)。
 * done と blocked だけは «状態が変わった» ことを示すので印を残す。
 */
export function reportMessage(
  kind: string,
  text: string,
  contextLine: string | null = null,
): MessagePayload {
  if (kind === "blocked") {
    return {
      embeds: [{ color: COLOR_ALERT, title: "⛔ 進めません", description: text.slice(0, 4000) }],
      allowed_mentions: { parse: [] },
    };
  }
  const suffix = kind === "done" ? "\n-# ✅ この会話はここで終わりました" : "";
  return {
    content: withContext(text.slice(0, 1900) + suffix, contextLine),
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
