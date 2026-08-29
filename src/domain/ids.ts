/**
 * 識別子の生成。`session_key` は D1 の主キーであると同時に、**転写ログに現れる印**でもある。
 *
 * Stop hook はセッションの外から «どの実行だったか» を知る手段を持たない (cloud environment の
 * 環境変数は環境ごとに固定で、1 回の実行ごとには渡せない)。そこで指示文の先頭にこの印を置き、
 * hook 側は `transcript_path` を grep して拾う。だから **形が変わると hook が黙って外れる** —
 * 変えるときは `repo-template/.claude/hooks/kanata-stop.sh` の正規表現も一緒に直すこと。
 */

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) {
    out += HEX[b >> 4];
    out += HEX[b & 0x0f];
  }
  return out;
}

export const SESSION_KEY_PREFIX = "KANATA-";

/** hook 側の grep と同じ形。片方だけ変えない。 */
export const SESSION_KEY_RE = /^KANATA-[0-9a-f]{16}$/;

export function newSessionKey(): string {
  return `${SESSION_KEY_PREFIX}${randomHex(8)}`;
}

export function isSessionKey(value: string): boolean {
  return SESSION_KEY_RE.test(value);
}

export function newAskId(): string {
  return `ask_${randomHex(8)}`;
}

/**
 * 実装計画の識別子。**これがそのまま公開 URL (`/p/<plan_id>/`) の鍵になる**ので、
 * 総当たりが成立しない長さ (128bit) を取る。`KANATA-` のような接頭辞は付けない —
 * 転写ログから拾う用途が無く、URL に載る文字を増やす理由が無い。
 */
export function newPlanId(): string {
  return randomHex(16);
}

export const PLAN_ID_RE = /^[0-9a-f]{32}$/;

export function isPlanId(value: string): boolean {
  return PLAN_ID_RE.test(value);
}
