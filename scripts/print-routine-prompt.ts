/**
 * claude.ai の routine に貼り付けるプロンプトを出す。`node scripts/print-routine-prompt.ts`。
 *
 * 正本は `src/domain/prompt.ts` の `ROUTINE_PROMPT`。ここを直したら **routine 側も貼り直す**
 * こと (ズレても静かに動き続け、ask_human が呼ばれなくなるだけなので気づきにくい)。
 */
import { ROUTINE_PROMPT } from "../src/domain/prompt.ts";

console.log(ROUTINE_PROMPT);
