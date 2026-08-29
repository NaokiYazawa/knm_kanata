import { escapeHtml } from "../domain/markdown";
import { toJstLabel } from "../domain/time";

/**
 * 計画を読むページの外枠。純粋。
 *
 * 読む場所は **スマホの Discord から開いた内蔵ブラウザ**が主。だから
 *
 * - 1 カラム。本文の幅は日本語が読める長さ (全角 40 字前後) で止める
 * - 端末の明暗にそのまま従う (`prefers-color-scheme`)。切り替えの UI は持たない
 * - 表とコードだけが横に溢れるので、**その入れ物だけ**を横スクロールにする
 *   (ページ全体が横に動くと本文が読めなくなる)
 * - スクリプトを 1 行も置かない。CSP (`default-src 'none'`) と噛み合わせる
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --fg: #1d1c1a;
  --muted: #6b6862;
  --line: #e0ddd6;
  --accent: #8a5a2b;
  --code-bg: #f1efea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151a;
    --fg: #e6e3dd;
    --muted: #9b968d;
    --line: #322f38;
    --accent: #d9a066;
    --code-bg: #201f26;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 16px;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.wrap { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.1rem 6rem; }
nav {
  border-bottom: 1px solid var(--line);
  padding-bottom: .8rem;
  margin-bottom: 1.6rem;
  font-size: .82rem;
  line-height: 2.1;
  color: var(--muted);
}
nav .name { display: block; font-weight: 600; color: var(--fg); font-size: .9rem; }
nav a { color: var(--muted); text-decoration: none; margin-right: .9rem; white-space: nowrap; }
nav a:hover { color: var(--accent); }
nav a[aria-current] { color: var(--fg); font-weight: 600; }
h1, h2, h3, h4, h5, h6 { line-height: 1.5; margin: 2.4rem 0 .9rem; }
h1 { font-size: 1.55rem; margin-top: 0; }
h2 { font-size: 1.28rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.1rem; }
h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote { margin: 0 0 1.1rem; }
li { margin: .25rem 0; }
a { color: var(--accent); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.4rem 0; }
blockquote {
  border-left: 3px solid var(--line);
  margin-left: 0;
  padding: .1rem 0 .1rem 1rem;
  color: var(--muted);
}
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: .86em;
  background: var(--code-bg);
  padding: .12em .35em;
  border-radius: 3px;
}
pre {
  background: var(--code-bg);
  padding: .9rem 1rem;
  border-radius: 6px;
  overflow-x: auto;
  line-height: 1.65;
}
pre code { background: none; padding: 0; font-size: .82rem; }
.scroll { overflow-x: auto; margin: 0 0 1.2rem; }
table { border-collapse: collapse; font-size: .85rem; line-height: 1.7; }
th, td { border: 1px solid var(--line); padding: .4rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); white-space: nowrap; }
img { max-width: 100%; }
footer { margin-top: 4rem; padding-top: .8rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .78rem; }
`.trim();

export type PlanNavItem = Readonly<{ path: string; href: string; current: boolean }>;

export function planPage(input: {
  /** ページの題。文書の最初の見出し。無ければファイル名。 */
  title: string;
  /** 計画の名前 (slug)。 */
  planName: string;
  files: readonly PlanNavItem[];
  bodyHtml: string;
  /** 最後に置き直した時刻 (UTC の ISO)。 */
  updatedAt: string;
}): string {
  const nav = input.files
    .map(
      (file) =>
        `<a href="${escapeHtml(file.href)}"${file.current ? ' aria-current="page"' : ""}>${escapeHtml(file.path)}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<nav><span class="name">${escapeHtml(input.planName)}</span>${nav}</nav>
<main class="md">
${input.bodyHtml}
</main>
<footer>kanata / 最終更新 ${escapeHtml(toJstLabel(input.updatedAt))}</footer>
</div>
</body>
</html>
`;
}

/** 見つからないときの頁。**何が無いのかは書かない** (存在の有無を漏らさない)。 */
export function planNotFoundPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>見つかりません</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap"><h1>見つかりません</h1><p>この URL には何もありません。</p></div></body>
</html>
`;
}
