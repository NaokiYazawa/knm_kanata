/**
 * 「Claude が人に聞く」ことの純粋層。Discord の制約 (ボタン 1 行 5 個・最大 5 行・ラベル 80 字・
 * custom_id 100 字) をここで吸収し、`discord/` 側は組み立てるだけにする。
 *
 * 制約を越えた入力を **黙って切り捨てない** — 選択肢が 30 個来たら «多すぎる» と Claude に返す。
 * 勝手に 25 個へ削ると、Claude が想定した選択肢と人が押せる選択肢がズレる。
 */

/** 1 行 5 個 × 5 行 = 25。最後の 1 枠は「自由に書く」に使うので 24 まで。 */
export const MAX_OPTIONS = 20;
/** Discord のボタンラベル上限。 */
export const MAX_OPTION_LENGTH = 80;
export const MAX_QUESTION_LENGTH = 1800;

export type AskInputProblem = Readonly<{ message: string }>;

export type AskInput = Readonly<{
  sessionKey: string;
  question: string;
  options: readonly string[];
  allowFreeText: boolean;
}>;

export function validateAsk(input: {
  sessionKey: string;
  question: unknown;
  options: unknown;
  allowFreeText: unknown;
}): AskInput | AskInputProblem {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question === "") return { message: "question が空です" };
  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      message: `question が長すぎます (${question.length} 字 / 上限 ${MAX_QUESTION_LENGTH} 字)`,
    };
  }

  const rawOptions = input.options ?? [];
  if (!Array.isArray(rawOptions)) return { message: "options は文字列の配列にしてください" };
  if (rawOptions.length > MAX_OPTIONS) {
    return {
      message: `options が多すぎます (${rawOptions.length} 個 / 上限 ${MAX_OPTIONS} 個)。選択肢を絞るか allow_free_text だけで聞いてください`,
    };
  }

  const options: string[] = [];
  for (const [index, raw] of rawOptions.entries()) {
    if (typeof raw !== "string") return { message: `options[${index}] が文字列ではありません` };
    const option = raw.trim();
    if (option === "") return { message: `options[${index}] が空です` };
    if (option.length > MAX_OPTION_LENGTH) {
      return {
        message: `options[${index}] が長すぎます (${option.length} 字 / 上限 ${MAX_OPTION_LENGTH} 字)`,
      };
    }
    if (options.includes(option))
      return { message: `options に同じ値 (${option}) が 2 つあります` };
    options.push(option);
  }

  // 既定で自由記述を許す。押す口が 1 つも無い質問を作れてしまうのを構造で防ぐ。
  const allowFreeText = input.allowFreeText === undefined ? true : input.allowFreeText === true;
  if (options.length === 0 && !allowFreeText) {
    return { message: "options が空で allow_free_text も false だと、人が答える手段がありません" };
  }

  return { sessionKey: input.sessionKey, question, options, allowFreeText };
}

export function isAskProblem(value: AskInput | AskInputProblem): value is AskInputProblem {
  return !("question" in value);
}

/* ---- Discord の custom_id ---- */

export type AskAction =
  | Readonly<{ kind: "pick"; askId: string; index: number }>
  | Readonly<{ kind: "free"; askId: string }>
  | Readonly<{ kind: "modal"; askId: string }>;

export const MODAL_ANSWER_FIELD = "answer";

export function pickCustomId(askId: string, index: number): string {
  return `ask:${askId}:${index}`;
}

export function freeCustomId(askId: string): string {
  return `askfree:${askId}`;
}

export function modalCustomId(askId: string): string {
  return `askmodal:${askId}`;
}

export function parseAskAction(customId: string): AskAction | null {
  const parts = customId.split(":");
  const head = parts[0];
  const askId = parts[1];
  if (!askId) return null;

  if (head === "ask") {
    const index = Number(parts[2]);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_OPTIONS) return null;
    return { kind: "pick", askId, index };
  }
  if (head === "askfree") return { kind: "free", askId };
  if (head === "askmodal") return { kind: "modal", askId };
  return null;
}
