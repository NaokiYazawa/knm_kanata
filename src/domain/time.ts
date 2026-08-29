/**
 * 時刻の処理はここだけが持つ。**保存は UTC / 見せるのは JST**。
 * `"Asia/Tokyo"` や `+9` を他のファイルへ書かない (書いた瞬間に «22 時に頼んだのに 13 時と
 * 書いてある» が生まれる)。
 */

const JST_TIME_ZONE = "Asia/Tokyo";

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: JST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** DB に入れる形。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 画面・Discord に出す形。引数は DB に入っている UTC の ISO 文字列。 */
export function toJstLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${jstFormatter.format(date)} JST`;
}

/** 経過時間。「3 分 20 秒」のように出す。 */
export function elapsedLabel(fromIso: string, toIso: string): string {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return "-";
  const totalSeconds = Math.floor((to - from) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds} 秒`;
}
