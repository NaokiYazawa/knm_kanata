/**
 * 実装計画の «置き場» の規則。純粋。I/O は持たない。
 *
 * ## なぜ計画をリポジトリに入れないのか
 *
 * 実装計画は **使い捨て**で、実装が終われば最終的なコードとズレる。commit すると
 * «嘘が書いてある文書» が正史として残り続けるので、GitHub には入れない。かといって
 * Discord には出せない — メッセージは 2,000 字、`.md` を添付しても素のテキストにしか
 * ならず、計画の主体である**表が読めない**。
 *
 * そこで Worker が配る。置き場は R2、鍵は URL そのもの (`plan_id`)。
 *
 * ## 名前は «スレッド × slug» で決まる
 *
 * 同じ計画を直して出し直すたびに URL が変わると、スレッドに貼ったリンクが古い方を
 * 指し続ける。だから **どの計画かは «どのスレッドの何という名前か» で決まる**ものとし、
 * `plan_id` の発行と再利用は Worker の中だけで起きる (呼ぶ側は plan_id を知らない)。
 *
 * セッションが落ちて `§5.5` の restart で `session_key` が変わっても、スレッドが同じなら
 * 同じ URL に上書きされる。スレッドがまだ無い (起動に失敗した) ときだけセッションへ落とす。
 */

/** 計画の名前。ディレクトリ名から作る。URL には出ないが、スレッド内で一意になる。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isPlanSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** パス 1 階層ぶんの形。**先頭のドットを許さない** (`.git` や `.env` を置かせない)。 */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** 1 つの計画に置けるファイルの深さ。計画は «7 ファイルの平置き» が典型なので十分。 */
const MAX_DEPTH = 6;

/**
 * アップロードと閲覧で使う相対パスの検証。
 *
 * R2 のキーは `{plan_id}/{path}` で組むので、**`..` や先頭の `/` を通すと他の計画の
 * オブジェクトに手が届く**。ここが唯一の関門なので、迷ったら弾く側へ倒す。
 */
export function normalizePlanPath(raw: string): string | null {
  if (raw === "" || raw.length > 400) return null;
  if (raw.startsWith("/")) return null;
  const segments = raw.split("/");
  if (segments.length > MAX_DEPTH) return null;
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) return null;
  }
  return segments.join("/");
}

/**
 * 計画の «同一性». スレッドがあればスレッド、無ければセッション。
 * `db/repo.ts` の `plans.scope` にそのまま入る。
 */
export function planScope(input: { threadId: string | null; sessionKey: string }): string {
  return input.threadId ? `thread:${input.threadId}` : `session:${input.sessionKey}`;
}

/**
 * 置いてあるバイト列を **どの Content-Type で返すか**。
 *
 * **`text/html` を返す枝を作らない。** 置けるのは Bearer を持つセッションだけとはいえ、
 * 公開 URL から自分のオリジンで任意の HTML が動く形を残す理由が無い。`svg` も
 * スクリプトを持てるので画像に含めず `text/plain` へ落とす。
 */
export function planContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "text/plain; charset=utf-8";
  }
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** 入口。`README.md` があればそれ、無ければ最初の markdown。 */
export function entryPath(paths: readonly string[]): string | null {
  const sorted = [...paths].sort();
  const readme = sorted.find((p) => p.toLowerCase() === "readme.md");
  if (readme) return readme;
  return sorted.find((p) => isMarkdownPath(p)) ?? sorted[0] ?? null;
}
