// ============================================================
//  ADMIN ARTICLES  —  /api/admin-articles
// ============================================================
//
//  GET    /api/admin-articles              — list all articles
//  GET    /api/admin-articles?slug=x       — fetch one (with body)
//  GET    /api/admin-articles?slug=x&preview=1 — rendered HTML preview
//  POST   /api/admin-articles              — create
//  PUT    /api/admin-articles              — update (body carries slug)
//  DELETE /api/admin-articles?slug=x       — delete
//
//  All routes require a valid staff session, the same Bearer-token
//  scheme used by admin-volunteers and admin-calendar.
//
//  ── WHY CONTENT, NOT PAGES ────────────────────────────────
//  Only the markdown body and its metadata are stored. The full
//  page (nav, footer, meta tags, JSON-LD) is generated at request
//  time by functions/news/[slug].ts from the shared template.
//  In the hand-written articles this chrome accounted for 54–94%
//  of each file, duplicated per article; keeping it in one
//  template means a nav change is a one-line edit rather than a
//  pass over every article ever published.
//
// ============================================================

import {
  markdownToHtml, renderArticlePage, slugify, isValidSlug,
  readingTime, safeUrl, type Article
} from "../_lib/article-render";

import { can, forbidden } from "../_lib/roles";

interface Env {
  CORE_DB: D1Database;
}

const MAX_TITLE   = 200;
const MAX_SUMMARY = 500;
const MAX_BODY    = 200_000;   // ~200 KB of markdown; far above any real article
const CATEGORIES  = ["Article", "Campaign", "Press Release", "Statement", "Update"];

// ============================================================
//  ROUTING
// ============================================================

export async function onRequest(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  if (!env.CORE_DB) return jsonError("CORE_DB not configured", 500);

  const session = await resolveSession(request, env.CORE_DB);
  if (!session) return jsonError("Unauthorized", 401);

  const url = new URL(request.url);

  // Reading drafts is broader than editing them; publishing puts text
  // on the public website, which is a different kind of mistake.
  const needed = request.method === "GET" ? "articles:read" : "articles:write";
  if (!can(session.role, needed)) {
    return forbidden(needed, session.role);
  }

  try {
    switch (request.method) {
      case "GET":    return await handleGet(url, env, session);
      case "POST":   return await handleCreate(request, env, session);
      case "PUT":    return await handleUpdate(request, env, session);
      case "DELETE": return await handleDelete(url, env, session);
      default:       return jsonError("Method not allowed", 405);
    }
  } catch (err) {
    console.error("admin-articles error:", err);
    return jsonError("Internal server error", 500);
  }
}

// ============================================================
//  READ
// ============================================================

async function handleGet(url: URL, env: Env, session: SessionContext): Promise<Response> {
  const slug = url.searchParams.get("slug");

  // ── Single article ──────────────────────────────────────
  if (slug) {
    if (!isValidSlug(slug)) return jsonError("Invalid slug", 400);

    const row = await env.CORE_DB
      .prepare(`SELECT * FROM articles WHERE slug = ?`)
      .bind(slug)
      .first<Article>();

    if (!row) return jsonError("Article not found", 404);

    // Rendered preview — lets staff see the real page before publishing
    if (url.searchParams.get("preview") === "1") {
      return new Response(renderArticlePage(row), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // A draft must never be cached or indexed
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow"
        }
      });
    }

    return secureJson({ article: row, body_html: markdownToHtml(row.body_md) });
  }

  // ── List ────────────────────────────────────────────────
  const status = url.searchParams.get("status");
  let query = `SELECT slug, title, summary, category, author, image, featured,
                      status, published_at, created_at, updated_at, updated_by,
                      LENGTH(body_md) AS body_length
               FROM articles`;
  const binds: string[] = [];

  if (status === "draft" || status === "published") {
    query += ` WHERE status = ?`;
    binds.push(status);
  }
  query += ` ORDER BY COALESCE(published_at, created_at) DESC`;

  const { results } = await env.CORE_DB.prepare(query).bind(...binds).all();

  await logAccess(env, session, "list_articles", results?.length ?? 0);

  return secureJson({
    articles: results ?? [],
    counts: await getCounts(env)
  });
}

async function getCounts(env: Env) {
  const row = await env.CORE_DB.prepare(
    `SELECT
       COUNT(*)                                        AS total,
       SUM(CASE WHEN status = 'published' THEN 1 END)  AS published,
       SUM(CASE WHEN status = 'draft'     THEN 1 END)  AS drafts
     FROM articles`
  ).first<{ total: number; published: number; drafts: number }>();
  return {
    total:     row?.total     ?? 0,
    published: row?.published ?? 0,
    drafts:    row?.drafts    ?? 0
  };
}

// ============================================================
//  CREATE
// ============================================================

async function handleCreate(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body", 400);

  const parsed = validate(body, { requireSlug: false });
  if ("error" in parsed) return jsonError(parsed.error, 400);
  const a = parsed.value;

	// articles:write lets someone create/edit a draft; making it visible
  // on the public site is a separate, checked action -- see H6 in the
  // security review. This is currently a no-op for every real role
  // (everyone holding articles:write also holds articles:publish today),
  // but validate() will accept status:"published" from anyone who can
  // reach this endpoint at all, so the gate has to live here rather than
  // rely on that coincidence holding forever.
  if (a.status === "published" && !can(session.role, "articles:publish")) {
    return forbidden("articles:publish", session.role);
  }

  const existing = await env.CORE_DB
    .prepare(`SELECT slug FROM articles WHERE slug = ?`)
    .bind(a.slug)
    .first();

  if (existing) {
    return jsonError(
      `An article with the URL "${a.slug}" already exists. Change the title or edit the existing article.`,
      409
    );
  }

  const now = new Date().toISOString();

  await env.CORE_DB.prepare(`
    INSERT INTO articles
      (slug, title, summary, body_md, category, author, image, featured,
       status, published_at, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    a.slug, a.title, a.summary, a.body_md, a.category, a.author, a.image,
    a.featured, a.status, a.status === "published" ? (a.published_at || now) : null,
    now, now, session.username, session.username
  ).run();

  await logAccess(env, session, `create_article:${a.slug}`, 1);

  return secureJson({
    success: true,
    slug: a.slug,
    status: a.status,
    url: `/news/${a.slug}`,
    reading_time: readingTime(a.body_md)
  }, 201);
}

// ============================================================
//  UPDATE
// ============================================================

async function handleUpdate(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body", 400);

  const originalSlug = typeof body.original_slug === "string" ? body.original_slug : null;
  if (!originalSlug || !isValidSlug(originalSlug)) {
    return jsonError("Missing or invalid original_slug", 400);
  }

  const current = await env.CORE_DB
    .prepare(`SELECT * FROM articles WHERE slug = ?`)
    .bind(originalSlug)
    .first<Article>();

  if (!current) return jsonError("Article not found", 404);

  const parsed = validate(body, { requireSlug: true });
  if ("error" in parsed) return jsonError(parsed.error, 400);
  const a = parsed.value;

	// Same gate as handleCreate -- see the comment there. Applies whether
  // this edit is what newly publishes the article or just re-saves an
  // already-published one; either way the request lands with
  // status:"published", so either way it needs articles:publish.
  if (a.status === "published" && !can(session.role, "articles:publish")) {
    return forbidden("articles:publish", session.role);
  }

  // Renaming the slug changes a public URL. Allowed, but never
  // silently over the top of a different existing article.
  if (a.slug !== originalSlug) {
    const clash = await env.CORE_DB
      .prepare(`SELECT slug FROM articles WHERE slug = ?`).bind(a.slug).first();
    if (clash) return jsonError(`Another article already uses the URL "${a.slug}".`, 409);
  }

  const now = new Date().toISOString();

  // Preserve the original publish date across edits; only stamp it
  // the first time an article actually goes live.
  let publishedAt = current.published_at;
  if (a.status === "published" && !publishedAt) publishedAt = a.published_at || now;
  if (a.status === "draft") publishedAt = current.published_at;   // keep for re-publish
  if (a.published_at && a.status === "published") publishedAt = a.published_at;

  await env.CORE_DB.prepare(`
    UPDATE articles
       SET slug = ?, title = ?, summary = ?, body_md = ?, category = ?,
           author = ?, image = ?, featured = ?, status = ?, published_at = ?,
           updated_at = ?, updated_by = ?
     WHERE slug = ?
  `).bind(
    a.slug, a.title, a.summary, a.body_md, a.category, a.author, a.image,
    a.featured, a.status, publishedAt, now, session.username, originalSlug
  ).run();

  await logAccess(env, session, `update_article:${a.slug}`, 1);

  return secureJson({
    success: true,
    slug: a.slug,
    status: a.status,
    slug_changed: a.slug !== originalSlug,
    url: `/news/${a.slug}`
  });
}

// ============================================================
//  DELETE
// ============================================================

async function handleDelete(url: URL, env: Env, session: SessionContext): Promise<Response> {
  const slug = url.searchParams.get("slug");
  if (!slug || !isValidSlug(slug)) return jsonError("Invalid slug", 400);

  const existing = await env.CORE_DB
    .prepare(`SELECT slug, status FROM articles WHERE slug = ?`).bind(slug).first<Article>();
  if (!existing) return jsonError("Article not found", 404);

  await env.CORE_DB.prepare(`DELETE FROM articles WHERE slug = ?`).bind(slug).run();
  await logAccess(env, session, `delete_article:${slug}`, 1);

  return secureJson({ success: true, slug });
}

// ============================================================
//  VALIDATION
// ============================================================

type ValidatedArticle = {
  slug: string; title: string; summary: string | null; body_md: string;
  category: string; author: string; image: string | null;
  featured: number; status: string; published_at: string | null;
};

function validate(
  body: Record<string, unknown>,
  opts: { requireSlug: boolean }
): { value: ValidatedArticle } | { error: string } {

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { error: "Title is required." };
  if (title.length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or fewer.` };

  const bodyMd = typeof body.body_md === "string" ? body.body_md : "";
  if (!bodyMd.trim()) return { error: "Article body is required." };
  if (bodyMd.length > MAX_BODY) return { error: "Article body is too long." };

  // Slug: explicit if given, otherwise derived from the title
  let slug = typeof body.slug === "string" && body.slug.trim()
    ? body.slug.trim().toLowerCase()
    : slugify(title);

  if (!isValidSlug(slug)) {
    return { error: "The URL must be 3–80 characters, lowercase letters, numbers and single hyphens." };
  }

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  if (summary.length > MAX_SUMMARY) {
    return { error: `Summary must be ${MAX_SUMMARY} characters or fewer.` };
  }

  const category = typeof body.category === "string" && CATEGORIES.includes(body.category)
    ? body.category : "Article";

  const author = typeof body.author === "string" && body.author.trim()
    ? body.author.trim().slice(0, 120) : "Campaign Team";

  // Images are referenced by path; reject anything script-bearing
  let image: string | null = null;
  if (typeof body.image === "string" && body.image.trim()) {
    const checked = safeUrl(body.image.trim());
    if (!checked) return { error: "The image path is not a valid URL." };
    image = checked;
  }

  const status = body.status === "published" ? "published" : "draft";

  let publishedAt: string | null = null;
  if (typeof body.published_at === "string" && body.published_at.trim()) {
    const d = new Date(body.published_at.length === 10
      ? `${body.published_at}T12:00:00Z` : body.published_at);
    if (isNaN(d.getTime())) return { error: "Publish date is not a valid date." };
    publishedAt = d.toISOString();
  }

  return {
    value: {
      slug, title, summary: summary || null, body_md: bodyMd,
      category, author, image,
      featured: body.featured ? 1 : 0,
      status, published_at: publishedAt
    }
  };
}

// ============================================================
//  HELPERS
// ============================================================

function secureJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function logAccess(
  env: Env, session: SessionContext, action: string, count: number
): Promise<void> {
  try {
    await env.CORE_DB.prepare(`
      INSERT INTO staff_access_log
        (log_id, staff_id, session_id, action, ip_hash, accessed_at, record_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), session.staffId, session.sessionId,
      action, "", new Date().toISOString(), count
    ).run();
  } catch (err) {
    // An audit-log failure must not block the operation itself
    console.error("Failed to write access log:", err);
  }
}

// ============================================================
//  SESSION RESOLUTION
// ============================================================
//
//  Duplicated from admin-auth.ts, matching the convention already
//  used in admin-volunteers.ts and admin-calendar.ts. Keep all
//  copies in sync if the validation logic changes.
//
// ============================================================

interface SessionContext {
  sessionId: string;
  staffId:   string;
  username:  string;
  role:      string;
}

async function resolveSession(request: Request, db: D1Database): Promise<SessionContext | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7).trim();
  if (!token) return null;

  const tokenHash = await sha256Hex(token);

  const row = await db.prepare(`
    SELECT s.session_id, s.staff_id, s.ip_hash, s.ua_hash, a.username, a.role
      FROM staff_sessions s
      JOIN staff_accounts a ON a.staff_id = s.staff_id
     WHERE s.token_hash = ?
       AND s.invalidated_at IS NULL
       AND s.expires_at > ?
       AND  a.disabled_at IS NULL
  `).bind(tokenHash, new Date().toISOString())
    .first<{ session_id: string; staff_id: string; ip_hash: string;
             ua_hash: string; username: string; role: string }>();

  if (!row) return null;

  // Bind the session to the originating client
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "unknown";
  if (row.ip_hash && row.ip_hash !== await sha256Hex(ip)) return null;
  if (row.ua_hash && row.ua_hash !== await sha256Hex(ua)) return null;

  return {
    sessionId: row.session_id,
    staffId:   row.staff_id,
    username:  row.username,
    role:      row.role
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
