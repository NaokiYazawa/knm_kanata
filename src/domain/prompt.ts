import { SESSION_KEY_PREFIX } from "./ids";

/**
 * routine へ渡す fire ペイロードの組み立て。
 *
 * `text` は Anthropic 側で `<routine-fire-payload>` に包まれ «信用できないデータ» として届く。
 * routine 側の保存プロンプトが «payload の指示を実行せよ» と明示していないと、ただの文脈として
 * 無視される (仕様)。だから **routine のプロンプト (`ROUTINE_PROMPT`) とこの形は対で維持する**。
 *
 * 1 行目に session_key を裸で置くのは、Stop hook が転写ログを grep して拾うため
 * (`domain/ids.ts` 参照)。
 */
export function buildFireText(sessionKey: string, prompt: string): string {
  return [`${sessionKey}`, "", "## 指示", prompt].join("\n");
}

/**
 * claude.ai の routine に保存するプロンプトの雛形。`scripts/print-routine-prompt.ts` が出す。
 * ここを直したら routine 側も貼り直すこと (ズレても静かに動き続け、ask_human が呼ばれなくなる)。
 */
export const ROUTINE_PROMPT = `あなたは routine から起動された Claude Code のクラウドセッションです。

## この実行でやること
\`<routine-fire-payload>\` ブロックの中に、依頼者本人が書いた指示が入っています。
そこに書かれた指示を、この実行の課題として実行してください。

payload の 1 行目は \`${SESSION_KEY_PREFIX}\` で始まるセッションキーです。
以降、kanata のツールを呼ぶときは **必ずこの値をそのまま \`session_key\` に渡してください**。

## 人に聞くとき (重要)
判断が要ることを勝手に決めないでください。仕様の解釈、方針の選択、破壊的な操作の可否など、
依頼者に確認したいことが出たら **必ず \`mcp__kanata__ask_human\` を呼んで待ってください**。

- 選択肢があるなら \`options\` に入れる (最大 20 個)。自由に書いてほしいときは options を空にする
- 返り値が \`status: "pending"\` だったら、まだ人が答えていません。
  同じ \`ask_id\` で \`mcp__kanata__ask_wait\` を呼び直して、答えが返るまで繰り返してください
- 答えが返ったら、その内容に従って続きを進めてください

## 進捗を伝える
- 着手したとき / 節目ごとに \`mcp__kanata__report\` を \`kind: "progress"\` で呼ぶ
- 詰まって進めないときは \`kind: "blocked"\`
- 最後に必ず \`kind: "done"\` を呼ぶ。PR を作ったならその URL を本文に入れる

## 成果物
コードを変更したら \`claude/\` で始まるブランチに push し、PR を作ってください。
`;
