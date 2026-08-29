/**
 * 個人用なので allowlist は 1 件。ここを通らないものは何もできない (fail-closed)。
 *
 * 設定値は **前後の空白を落としてから**比べる。`echo "…" | wrangler secret put` のように渡すと
 * 末尾に改行が入り、«値は合っているのに弾かれる» が無言で起きるため。空欄のときは誰も通さない
 * (空文字どうしが一致して全員通る、を作らない)。
 */
export function isOwner(configured: string | undefined, actual: string | null): boolean {
  const owner = (configured ?? "").trim();
  if (owner === "") return false;
  return actual !== null && actual.trim() === owner;
}
