// ============================================================
//  PUBLIC NEWS INDEX  —  /api/news
// ============================================================
//
//  Returns published articles as the same JSON shape that
//  public/news/articles.json uses, so news-pages.js consumes it
//  with no change to its rendering logic.
//
//  The static articles.json is still merged in, which keeps the
//  three hand-written articles listed alongside D1 ones. Remove
//  that merge once they're migrated.
//
//  Public endpoint — no session required — so it exposes only
//  published articles and never the markdown body.
//
// ============================================================

interface Env { CORE_DB: D1Database; }

interface IndexEntry {
  slug: string; title: string; date: string; summary: string;
  category: string; featured: boolean; image: string; author: string;
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const entries: IndexEntry[] = [];

  // ── D1 articles ─────────────────────────────────────────
  try {
    if (context.env?.CORE_DB) {
      const { results } = await context.env.CORE_DB.prepare(`
        SELECT slug, title, summary, category, author, image, featured,
               COALESCE(published_at, created_at) AS date
          FROM articles
         WHERE status = 'published'
         ORDER BY COALESCE(published_at, created_at) DESC
      `).all<any>();

      for (const row of results ?? []) {
        entries.push({
          slug:     row.slug,
          title:    row.title,
          date:     String(row.date ?? "").slice(0, 10),
          summary:  row.summary ?? "",
          category: row.category ?? "Article",
          featured: !!row.featured,
          image:    row.image ?? "",
          author:   row.author ?? "Campaign Team"
        });
      }
    }
  } catch (err) {
    console.error("News index query failed:", err);
    // Fall through — the static file below still provides a listing
  }

  // ── Legacy static articles ──────────────────────────────
  try {
    const staticUrl = new URL("/news/articles.json", context.request.url);
    const res = await fetch(staticUrl.toString());
    if (res.ok) {
      const legacy = await res.json() as IndexEntry[];
      const seen = new Set(entries.map(e => e.slug));
      for (const item of legacy) {
        if (item?.slug && !seen.has(item.slug)) entries.push(item);
      }
    }
  } catch {
    // Static index missing is fine once everything is migrated
  }

  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return new Response(JSON.stringify(entries), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=3600"
    }
  });
}
