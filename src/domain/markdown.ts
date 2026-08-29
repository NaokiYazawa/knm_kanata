import { Marked, Renderer, type Tokens } from "marked";

/**
 * markdown を HTML にする。純粋 (I/O を持たない)。
 *
 * 素の `marked` をそのまま使わない理由が 3 つある。
 *
 * ## 1. 生 HTML はエスケープする
 *
 * `marked` の既定は «markdown に書かれた HTML をそのまま出す» で、実装計画にはそれが
 * 致命的に合わない。既存の計画には `<URL>` `<string>` `<LinkChip …>` `<script>` のような
 * **山括弧を含む地の文**が 40 箇所以上ある (実測)。素通しにするとブラウザがタグとして
 * 飲み込み、**本文がそこだけ消える**。読み手には «なぜか説明が抜けている文書» にしか
 * 見えないので、事故として最悪の形。
 *
 * ついでに、これは安全側でもある (公開 URL から自分のオリジンで任意の HTML が動かない)。
 * CSP でもスクリプトは止めているので二重に塞いである。
 *
 * ## 2. 見出しの id を GitHub と同じにする
 *
 * 計画は `[§3.1](#31-キーが-confluence-と違う)` のように **GitHub が振る id を前提にした
 * 内部リンク**を持つ。同じ規則で振らないと、リンクを踏んでも飛ばない文書になる。
 *
 * ## 3. 外部リンクだけ別扱いにする
 *
 * `./phase-01-….md` のような相対リンクは **書き換えない** (`/p/<id>/README.md` から
 * `/p/<id>/phase-01-….md` に解決される)。書き換えないことが要件で、そのために
 * «URL をそのまま出す» ことをここで保証する。外部リンクには `rel` を足す。
 */

/**
 * GitHub 互換の見出し slug。
 *
 * 小文字化 → **文字・数字・`_`・半角ハイフン・半角空白以外を落とす** → 空白を `-` へ →
 * 重複には `-1` `-2` を足す。`### 3.1 キーが Confluence と違う` は
 * `31-キーが-confluence-と違う`。
 *
 * 残す文字の集合は `github-slugger` (GitHub 本体が使っているもの) と突き合わせて決めた。
 * 引っ掛かりやすいのは **ダッシュの扱い**で、半角 `-` は残るが `—` (em dash) や `–` は
 * 記号として消える (`a — b` → `a--b`、`A–B` → `ab`)。全角空白と絵文字も消える。
 * 素朴に «`\p{Pd}` を残す» と書くとここがずれて、リンクを踏んでも飛ばない見出しができる。
 *
 * 記号を落とすので、markdown の装飾 (`**` や `` ` ``) は自然に消える。
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `http(s)://` で始まるものだけ «外» とみなす。相対リンクは触らない。 */
function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * リンク先として許すもの。**`link` を差し替えると `marked` 本体の URL 検査を素通りする**ので、
 * ここで同じ役目を果たす。`javascript:` などスキームを持つものは通さない (CSP でも止まるが、
 * 差し替えた側が «素通しにした» 形を残さない)。
 */
function isSafeHref(href: string): boolean {
  if (/^(https?|mailto):/i.test(href)) return true;
  // スキームらしきものが付いていなければ相対リンク (`./phase-01.md` `#anchor` `foo/bar`)。
  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

class PlanRenderer extends Renderer {
  /** 最初の見出し。ページの `<title>` に使う。 */
  firstHeading: string | null = null;

  constructor(private readonly slug: (text: string) => string) {
    super();
  }

  override heading(token: Tokens.Heading): string {
    const html = this.parser.parseInline(token.tokens);
    // slug は «描画後の文字» から作る。GitHub がそうしているので、リンクの形が揃う。
    const plain = this.parser.parseInline(token.tokens, this.parser.textRenderer);
    if (this.firstHeading === null) this.firstHeading = plain.trim();
    const id = this.slug(plain);
    return `<h${token.depth} id="${escapeHtml(id)}">${html}</h${token.depth}>\n`;
  }

  /** ブロックの生 HTML もインラインのタグも、両方ここへ来る (仕様)。 */
  override html(token: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(token.text);
  }

  /**
   * 表は横に溢れる (計画の表は列が多い)。**入れ物ごと横スクロールにする** —
   * `table` 自体を `display: block` にすると幅の計算が崩れるので、外側で受ける。
   */
  override table(token: Tokens.Table): string {
    return `<div class="scroll">${super.table(token)}</div>\n`;
  }

  override link(token: Tokens.Link): string {
    const text = this.parser.parseInline(token.tokens);
    if (!isSafeHref(token.href)) return text;
    const href = escapeHtml(token.href);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    const external = isExternal(token.href)
      ? ' target="_blank" rel="noopener noreferrer"'
      : // 相対リンクは同じ計画の中を指す。新しいタブを開かない (読みながら行き来する)。
        "";
    return `<a href="${href}"${title}${external}>${text}</a>`;
  }
}

export type RenderedMarkdown = Readonly<{
  html: string;
  /** 最初の見出し。無ければ null。 */
  title: string | null;
}>;

export function renderMarkdown(source: string): RenderedMarkdown {
  const renderer = new PlanRenderer(createSlugger());
  // **インスタンスを毎回作る。** slug の重複カウンタと «最初の見出し» が文書をまたいで残らない
  // ようにするため。`Renderer` のインスタンスを渡せるのは `setOptions` の側 (`use` は
  // プレーンなオブジェクトを期待していて、プロトタイプに生えたメソッドを拾わない)。
  const marked = new Marked().setOptions({ gfm: true, breaks: false, renderer });
  const html = marked.parse(source, { async: false });
  return { html, title: renderer.firstHeading };
}
