import type { Project } from "../domain/projects";

/**
 * Claude Code の routine を HTTP から起動する。
 *
 * このエンドポイントだけは Claude Platform API ではなく **Claude Code 側の面** で、
 * 認証も `x-api-key` ではなく «その routine だけを起動できる» per-routine の Bearer トークン。
 * SDK は無い (公式が «典型的な呼び出し側は CI や通知系なので直接叩く» としている)。
 *
 * beta ヘッダは必須で、無いと 400 になる。研究プレビューなので、日付つきの新しいヘッダが
 * 出たらここを上げる (直前 2 世代は動き続ける)。
 */

const FIRE_BETA_HEADER = "experimental-cc-routine-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

/** API 側の上限。超えると 400 になるので、送る前に弾いて理由を人に見せる。 */
export const MAX_FIRE_TEXT_LENGTH = 65_536;

export type FireResult =
  | Readonly<{ ok: true; sessionId: string; sessionUrl: string }>
  | Readonly<{ ok: false; detail: string }>;

type FireResponse = {
  claude_code_session_id?: string;
  claude_code_session_url?: string;
};

export async function fireRoutine(project: Project, text: string): Promise<FireResult> {
  if (text.length > MAX_FIRE_TEXT_LENGTH) {
    return {
      ok: false,
      detail: `指示が長すぎます (${text.length} 字 / 上限 ${MAX_FIRE_TEXT_LENGTH} 字)`,
    };
  }

  let response: Response;
  try {
    response = await fetch(project.fireUrl, {
      method: "POST",
      headers: {
        // トークンはここだけに現れる。例外メッセージにもログにも載せない。
        authorization: `Bearer ${project.fireToken}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": FIRE_BETA_HEADER,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    return { ok: false, detail: `routine の起動に失敗しました: ${String(error)}` };
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    return { ok: false, detail: `routine が ${response.status} を返しました: ${body}` };
  }

  const payload = (await response.json()) as FireResponse;
  const sessionId = payload.claude_code_session_id;
  const sessionUrl = payload.claude_code_session_url;
  if (!sessionId || !sessionUrl) {
    return { ok: false, detail: "routine の応答にセッション ID が含まれていません" };
  }
  return { ok: true, sessionId, sessionUrl };
}
