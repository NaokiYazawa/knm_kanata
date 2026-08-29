import { describe, expect, it } from "vitest";
import { entryPath, isPlanSlug, normalizePlanPath, planContentType, planScope } from "./plans";

describe("isPlanSlug", () => {
  it("小文字の英数字と - だけ通す", () => {
    expect(isPlanSlug("github-link")).toBe(true);
    expect(isPlanSlug("plans2")).toBe(true);
    expect(isPlanSlug("GitHub-Link")).toBe(false);
    expect(isPlanSlug("-leading")).toBe(false);
    expect(isPlanSlug("with/slash")).toBe(false);
    expect(isPlanSlug("")).toBe(false);
  });
});

describe("normalizePlanPath", () => {
  it("ふつうの相対パスを通す", () => {
    expect(normalizePlanPath("README.md")).toBe("README.md");
    expect(normalizePlanPath("docs/phase-01.md")).toBe("docs/phase-01.md");
  });

  it("**他の計画へ手が届く形を弾く**", () => {
    // R2 のキーは `{plan_id}/{path}` で組む。ここが唯一の関門。
    expect(normalizePlanPath("../other/README.md")).toBeNull();
    expect(normalizePlanPath("a/../../b.md")).toBeNull();
    expect(normalizePlanPath("/etc/passwd")).toBeNull();
  });

  it("ドットで始まるものを置かせない", () => {
    expect(normalizePlanPath(".env")).toBeNull();
    expect(normalizePlanPath("sub/.git/config")).toBeNull();
  });

  it("深すぎる / 長すぎるものを弾く", () => {
    expect(normalizePlanPath("a/b/c/d/e/f/g.md")).toBeNull();
    expect(normalizePlanPath(`${"a".repeat(500)}.md`)).toBeNull();
    expect(normalizePlanPath("")).toBeNull();
  });
});

describe("planScope", () => {
  it("スレッドがあればスレッドで決まる", () => {
    // セッションが落ちて起こし直されても、同じスレッドなら同じ URL に上書きされる。
    expect(planScope({ threadId: "th-1", sessionKey: "KANATA-1" })).toBe("thread:th-1");
    expect(planScope({ threadId: "th-1", sessionKey: "KANATA-2" })).toBe("thread:th-1");
  });

  it("スレッドが無ければセッションへ落とす", () => {
    expect(planScope({ threadId: null, sessionKey: "KANATA-1" })).toBe("session:KANATA-1");
  });
});

describe("planContentType", () => {
  it("**text/html を返す枝が無い**", () => {
    // 公開 URL から自分のオリジンで任意の HTML が動く形を残さない。
    expect(planContentType("page.html")).toBe("text/plain; charset=utf-8");
    expect(planContentType("icon.svg")).toBe("text/plain; charset=utf-8");
    expect(planContentType("notes.txt")).toBe("text/plain; charset=utf-8");
  });

  it("画像だけ画像として返す", () => {
    expect(planContentType("a/b.png")).toBe("image/png");
    expect(planContentType("shot.JPG")).toBe("image/jpeg");
  });
});

describe("entryPath", () => {
  it("README.md があれば入口はそれ", () => {
    expect(entryPath(["phase-01.md", "README.md"])).toBe("README.md");
  });

  it("無ければ最初の markdown", () => {
    expect(entryPath(["z.png", "design.md", "phase-01.md"])).toBe("design.md");
  });

  it("markdown が 1 つも無ければ最初のファイル", () => {
    expect(entryPath(["b.png", "a.png"])).toBe("a.png");
  });

  it("空なら null", () => {
    expect(entryPath([])).toBeNull();
  });
});
