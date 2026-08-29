import { describe, expect, it } from "vitest";
import { createSlugger, renderMarkdown } from "./markdown";

/**
 * 計画を «そのまま» 読ませられるかを固める。
 *
 * ここが崩れたときの症状は «文書の一部が黙って消える» / «内部リンクを踏んでも飛ばない» で、
 * どちらも読み手には壊れていると分からない形をしている。
 */

describe("createSlugger", () => {
  it("GitHub と同じ id を振る", () => {
    const slug = createSlugger();
    // 実際の計画にある見出しと、それを指しているリンク。
    expect(slug("3.1 キーが Confluence と違う")).toBe("31-キーが-confluence-と違う");
    expect(slug("1.5 実測 2026-08-05")).toBe("15-実測-2026-08-05");
    expect(slug("2. セキュリティ設計")).toBe("2-セキュリティ設計");
  });

  it("記号を落として空白を - にする", () => {
    const slug = createSlugger();
    expect(slug("Hello, World!")).toBe("hello-world");
    expect(slug("snake_case と kebab-case")).toBe("snake_case-と-kebab-case");
    expect(slug("§5.5 スレッドは 1 本の会話")).toBe("55-スレッドは-1-本の会話");
  });

  it("**半角ハイフンだけが残る** (— や – は記号として消える)", () => {
    // ここを «`\p{Pd}` を残す» と書くと GitHub とずれ、リンクを踏んでも飛ばない見出しができる。
    // 値は github-slugger (GitHub 本体のもの) と突き合わせてある。
    const slug = createSlugger();
    expect(slug("実装計画を Worker から配る — 設計")).toBe("実装計画を-worker-から配る--設計");
    expect(slug("A–B")).toBe("ab");
    expect(slug("1.5 実測 2026-08-05")).toBe("15-実測-2026-08-05");
  });

  it("全角空白と絵文字も消える", () => {
    const slug = createSlugger();
    expect(slug("全角　空白")).toBe("全角空白");
    expect(slug("絵文字 🚀 あり")).toBe("絵文字--あり");
  });

  it("重複には連番を足す", () => {
    const slug = createSlugger();
    expect(slug("まとめ")).toBe("まとめ");
    expect(slug("まとめ")).toBe("まとめ-1");
    expect(slug("まとめ")).toBe("まとめ-2");
  });

  it("文書をまたいでカウンタが残らない", () => {
    expect(createSlugger()("まとめ")).toBe("まとめ");
    expect(createSlugger()("まとめ")).toBe("まとめ");
  });
});

describe("renderMarkdown", () => {
  it("見出しに id を振り、最初の見出しを題として返す", () => {
    const { html, title } = renderMarkdown("# 設計\n\n## 3.1 キーが違う\n");
    expect(title).toBe("設計");
    expect(html).toContain('<h1 id="設計">設計</h1>');
    expect(html).toContain('<h2 id="31-キーが違う">');
  });

  it("GFM の表を出す", () => {
    const { html } = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
    // 表は横に溢れるので入れ物ごとスクロールさせる。
    expect(html).toContain('<div class="scroll">');
  });

  it("**生 HTML を必ずエスケープする**", () => {
    // 実際の計画には `<URL>` `<string>` `<script>` のような山括弧を含む地の文がある。
    // 素通しにするとブラウザが飲み込み、本文がそこだけ消える。
    const { html } = renderMarkdown("本文に <URL> と <script>alert(1)</script> が出てくる。\n");
    expect(html).toContain("&lt;URL&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("ブロックの生 HTML もエスケープする", () => {
    const { html } = renderMarkdown("<div onclick='x'>ここ</div>\n");
    expect(html).not.toContain("<div");
    expect(html).toContain("&lt;div");
  });

  it("相対リンクを書き換えない", () => {
    // 計画は `./phase-01-….md` で互いを指す。`/p/<id>/README.md` から
    // `/p/<id>/phase-01-….md` に解決されるので、こちらで触る必要が無い。
    const { html } = renderMarkdown("[次](./phase-01-github-app-permissions.md#0-前提)\n");
    expect(html).toContain('href="./phase-01-github-app-permissions.md#0-前提"');
    expect(html).not.toContain("target=");
  });

  it("外部リンクにだけ rel を付ける", () => {
    const { html } = renderMarkdown("[GitHub](https://github.com/example/x)\n");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("スキーム付きの怪しいリンクは a にしない", () => {
    // `link` を差し替えると marked 本体の URL 検査を素通りするので、同じ役目をこちらで持つ。
    const { html } = renderMarkdown("[押して](javascript:alert(1))\n");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("押して");
  });

  it("コードフェンスの中身をエスケープして出す", () => {
    const { html } = renderMarkdown("```ts\nconst a = 1 < 2;\n```\n");
    expect(html).toContain("<pre>");
    expect(html).toContain("1 &lt; 2");
  });

  it("見出しが無ければ題は null", () => {
    expect(renderMarkdown("ただの段落。\n").title).toBeNull();
  });
});
