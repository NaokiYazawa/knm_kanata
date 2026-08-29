import { Repo } from "../db/repo";
import { isPlanId } from "../domain/ids";
import { renderMarkdown } from "../domain/markdown";
import {
  entryPath,
  isMarkdownPath,
  isPlanSlug,
  normalizePlanPath,
  planContentType,
  planScope,
} from "../domain/plans";
import type { Env } from "../env";
import { type PlanNavItem, planNotFoundPage, planPage } from "./page";

/**
 * 実装計画を置いて、読ませる。
 *
 * ## なぜ Worker が配るのか
 *
 * 実装計画は使い捨てなので GitHub には入れない。かといって Discord には出せない
 * (2,000 字 / `.md` を添付しても素のテキストで、計画の主体である**表が読めない**)。
 * `domain/plans.ts` に置き場の規則を、ここに «口» を置く。
 *
 * ## 本文を Claude の出力に通さない
 *
 * ここが設計の要。計画は 1 件 200KB を超える (実測 231,647 バイト / 7 ファイル)。
 * **MCP ツールの引数に載せると Claude がその全部を再出力することになる**ので、置く口は
 * ツールではなく素の HTTP にしてある。`kanata-hook.sh` と同じく、シェルが `curl` で
 * バイト列をそのまま送る。Claude が読むのは最後に返る URL の 1 行だけ。
 *
 * ## 鍵は URL そのもの
 *
 * `/p/<plan_id>/` の `plan_id` が 128bit の «その文書を開ける鍵»。ログインは挟まない
 * (利用者判断)。だから **URL が外へ漏れる経路を塞ぐ**のがここの仕事:
 * `Referrer-Policy: no-referrer` で外部リンクを踏んでも Referer に載せず、
 * `X-Robots-Tag` で検索に載せず、`Cache-Control: private, no-store` で中間に残さない。
 */

/** 1 ファイルの上限。計画は markdown なので、これを超えるものは何かを間違えている。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** セッションキーを載せるヘッダ。本文は生のバイト列なので、body には入れられない。 */
export const SESSION_HEADER = "x-kanata-session";

/**
 * 読ませるページに必ず付ける。**`plan_id` は URL に載っている = 鍵が URL である**という
 * 前提の上に立っているので、URL が意図せず出ていく口を全部塞ぐ。
 */
function viewHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    // 生 HTML はエスケープしているが、破れてもスクリプトが動かないよう二重に塞ぐ。
    "content-security-policy":
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    // **外部リンクを踏んだときに URL (= 鍵) を渡さない。**
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  };
}

async function resolveScope(
  repo: Repo,
  sessionKey: string,
): Promise<{ scope: string; sessionKey: string } | null> {
  const session = await repo.getSession(sessionKey);
  if (!session) return null;
  return { scope: planScope(session), sessionKey };
}

/** その計画に置いてあるファイル (R2 のキーから接頭辞を落としたもの)。 */
async function listPlanFiles(env: Env, planId: string): Promise<string[]> {
  const prefix = `${planId}/`;
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PLANS.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const object of page.objects) paths.push(object.key.slice(prefix.length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return paths.sort();
}

/** `PUT /plans/:slug/:path` — ファイルを 1 つ置く。 */
export async function handlePlanUpload(
  request: Request,
  env: Env,
  slug: string,
  rawPath: string,
): Promise<Response> {
  if (!isPlanSlug(slug)) return new Response("bad slug", { status: 400 });
  const path = normalizePlanPath(rawPath);
  if (path === null) return new Response("bad path", { status: 400 });

  const sessionKey = request.headers.get(SESSION_HEADER)?.trim() ?? "";
  const repo = new Repo(env.DB);
  const scope = await resolveScope(repo, sessionKey);
  // 知らないセッションからは置かせない。どのスレッドの計画かが決まらず、URL を安定させられない。
  if (!scope) return new Response("unknown session", { status: 404 });

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_FILE_BYTES) return new Response("too large", { status: 413 });

  const plan = await repo.upsertPlan({ scope: scope.scope, slug, sessionKey });
  await env.PLANS.put(`${plan.planId}/${path}`, body);
  return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * `POST /plans/:slug/finish` — 置き終わり。
 *
 * **今回置かなかったものをここで消す。** 消さないと、名前を変えた古いファイルが並びに
 * 残り続けて «どれが今の計画か» が分からなくなる。消すのを最後にしているのは、先に消すと
 * 置き直している間だけ URL が空になるため。
 */
export async function handlePlanFinish(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  if (!isPlanSlug(slug)) return new Response("bad slug", { status: 400 });

  const sessionKey = request.headers.get(SESSION_HEADER)?.trim() ?? "";
  const repo = new Repo(env.DB);
  const scope = await resolveScope(repo, sessionKey);
  if (!scope) return new Response("unknown session", { status: 404 });

  let payload: { paths?: unknown };
  try {
    payload = (await request.json()) as { paths?: unknown };
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const kept = new Set<string>();
  if (Array.isArray(payload.paths)) {
    for (const value of payload.paths) {
      if (typeof value !== "string") continue;
      const path = normalizePlanPath(value);
      if (path) kept.add(path);
    }
  }
  if (kept.size === 0) return new Response("no files", { status: 400 });

  const plan = await repo.upsertPlan({ scope: scope.scope, slug, sessionKey });
  const stale = (await listPlanFiles(env, plan.planId)).filter((path) => !kept.has(path));
  if (stale.length > 0) await env.PLANS.delete(stale.map((path) => `${plan.planId}/${path}`));
  await repo.touchPlan(plan.planId);

  const url = `${new URL(request.url).origin}/p/${plan.planId}/`;
  return new Response(JSON.stringify({ url, plan_id: plan.planId }), {
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response(planNotFoundPage(), {
    status: 404,
    headers: viewHeaders("text/html; charset=utf-8"),
  });
}

/**
 * `GET /p/:planId/:path` — 読ませる。**ここだけがゲートを持たない公開 URL**。
 *
 * `path` が空なら入口 (`README.md`) を **そのまま**返す。リダイレクトしないのは、
 * `/p/<id>/` から見て `./phase-01.md` が `/p/<id>/phase-01.md` に解決されるため
 * (計画の中の相対リンクを 1 文字も書き換えずに済む、というのがこの作りの要点)。
 */
export async function handlePlanView(
  request: Request,
  env: Env,
  planId: string,
  rawPath: string,
): Promise<Response> {
  if (!isPlanId(planId)) return notFound();
  const repo = new Repo(env.DB);
  const plan = await repo.getPlan(planId);
  if (!plan) return notFound();

  const files = await listPlanFiles(env, planId);
  if (files.length === 0) return notFound();

  const path = rawPath === "" ? entryPath(files) : normalizePlanPath(rawPath);
  if (path === null) return notFound();

  const object = await env.PLANS.get(`${planId}/${path}`);
  if (!object) return notFound();

  const url = new URL(request.url);
  // 原文が要るのはセッション側 (`plans/` は gitignore なのでワークスペースと一緒に消える)。
  const raw = url.searchParams.get("raw") === "1";

  if (!isMarkdownPath(path) || raw) {
    const type = isMarkdownPath(path) ? "text/markdown; charset=utf-8" : planContentType(path);
    return new Response(object.body, { headers: viewHeaders(type) });
  }

  const source = await object.text();
  const rendered = renderMarkdown(source);
  const nav: PlanNavItem[] = files.map((file) => ({
    path: file,
    // **絶対パスで張る。** 入れ子のファイルから相対で張ると階層のぶんずれる。
    href: `/p/${planId}/${file}`,
    current: file === path,
  }));
  const html = planPage({
    title: rendered.title ?? path,
    planName: plan.slug,
    files: nav,
    bodyHtml: rendered.html,
    updatedAt: plan.updatedAt,
  });
  return new Response(html, { headers: viewHeaders("text/html; charset=utf-8") });
}
