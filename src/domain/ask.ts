/**
 * 「Claude が人に聞く」ことの純粋層。Discord の制約 (ボタン 1 行 5 個・最大 5 行・ラベル 80 字・
 * custom_id 100 字) をここで吸収し、`discord/` 側は組み立てるだけにする。
 *
 * 制約を越えた入力を **黙って切り捨てない** — 選択肢が 30 個来たら «多すぎる» と Claude に返す。
 * 勝手に 20 個へ削ると、Claude が想定した選択肢と人が押せる選択肢がズレる。
 *
 * ## 自由記述のボタンを持たない理由
 *
 * **選択肢に無いことを言いたいときは、スレッドに素で書けばそれが回答になる** (`domain/inbound.ts`)。
 * だから «✍️ 書く» ボタン → モーダル、という口は要らない。持たない方が良い理由がもう 1 つあって、
 * モーダルの送信に対する «元のメッセージを書き換える» 応答 (type 7) は Discord の仕様上
 * **コンポーネント由来の interaction にしか認められていない**。ボタンから開いたモーダルでは
 * 通るが、文書化されていない挙動に乗ることになる。使わない口のために踏む橋ではない。
 */

/** 1 行 5 個 × 最大 5 行 = 25 まで置けるが、20 を超える選択肢は読めないので上限にする。 */
export const MAX_OPTIONS = 20;
/** Discord のボタンラベル上限。 */
export const MAX_OPTION_LENGTH = 80;
export const MAX_QUESTION_LENGTH = 1800;

export type AskInputProblem = Readonly<{ message: string }>;

export type AskInput = Readonly<{
  sessionKey: string;
  question: string;
  options: readonly string[];
}>;

export function validateAsk(input: {
  sessionKey: string;
  question: unknown;
  options: unknown;
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
      message: `options が多すぎます (${rawOptions.length} 個 / 上限 ${MAX_OPTIONS} 個)。選択肢を絞るか、options を空にして自由に答えてもらってください`,
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

  // options が空でも問題ない。**スレッドに素で書けば回答になる**ので、答える手段は常にある。
  return { sessionKey: input.sessionKey, question, options };
}

export function isAskProblem(value: AskInput | AskInputProblem): value is AskInputProblem {
  return !("question" in value);
}

/* ---- Discord の custom_id ---- */

export type AskAction = Readonly<{ kind: "pick"; askId: string; index: number }>;

export function pickCustomId(askId: string, index: number): string {
  return `ask:${askId}:${index}`;
}

export function parseAskAction(customId: string): AskAction | null {
  const parts = customId.split(":");
  if (parts[0] !== "ask") return null;
  const askId = parts[1];
  if (!askId) return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_OPTIONS) return null;
  return { kind: "pick", askId, index };
}
