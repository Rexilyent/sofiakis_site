// ============================================================
//  PUBLIC ARTICLE PAGE  —  /news/:slug
// ============================================================
//
//  Renders a published article from D1 using the shared template.
//
//  ── FALLTHROUGH ───────────────────────────────────────────
//  If the slug isn't a published row in D1, this calls
//  context.next(), which hands the request back to Pages' static
//  asset handling. That means the three hand-written articles
//  already in public/news/ keep serving exactly as before, with
//  no migration required — D1 articles and static articles
//  coexist. Migrate the old ones whenever convenient, or never.
//
//  Drafts deliberately fall through to a 404 rather than
//  rendering, so an unpublished article is never reachable by
//  guessing its URL.
//
// ============================================================

import { renderArticlePage, isValidSlug, type Article } from "../_lib/article-render";

interface Env { CORE_DB: D1Database; }

export async function onRequestGet(context: {
  request: Request;
  env: Env;
  params: { slug: string };
  next: () => Promise<Response>;
}): Promise<Response> {
  const raw = context.params.slug;

  // Strip a trailing .html so /news/foo and /news/foo.html both work
  const slug = String(raw || "").replace(/\.html$/i, "");

  if (!isValidSlug(slug) || !context.env?.CORE_DB) {
    return context.next();
  }

  let article: Article | null = null;
  try {
    article = await context.env.CORE_DB
      .prepare(`SELECT * FROM articles WHERE slug = ? AND status = 'published'`)
      .bind(slug)
      .first<Article>();
  } catch (err) {
    // A database problem shouldn't take down articles that exist as
    // static files — fall through rather than erroring.
    console.error("Article lookup failed:", err);
    return context.next();
  }

  if (!article) return context.next();

  return new Response(renderArticlePage(article), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short edge cache: an article correction should go live quickly,
      // but repeat readers shouldn't re-render on every request.
      "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
