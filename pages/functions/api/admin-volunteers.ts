// ============================================================
//  ADMIN VOLUNTEER VIEWER  —  /api/admin-volunteers
// ============================================================
//
//  Returns decrypted volunteer PII to authenticated staff only.
//
//  GET  /api/admin-volunteers          — paginated volunteer list
//  GET  /api/admin-volunteers?id=<id>  — single volunteer record
//
//  All requests require:
//    Authorization: Bearer <session_token>
//
//  The token must have been issued by /api/admin-auth (POST) for
//  an account in staff_accounts with role "viewer" or "admin".
//
// ============================================================
//  SECURITY MODEL
// ============================================================
//
//  1. DECRYPTION IS SERVER-SIDE ONLY.
//     The FIELD_ENCRYPT_KEY never leaves the Worker. The client
//     receives already-decrypted strings over HTTPS — it never
//     touches ciphertext or encryption keys.
//
//  2. SESSION BINDING.
//     Every request re-validates the token AND checks that the
//     calling IP and User-Agent match the values recorded at
//     login time. A stolen token replayed from a different client
//     is rejected.
//
//  3. EVERY ACCESS IS LOGGED.
//     staff_access_log records who viewed what, when, from where
//     (IP hash), and how many records were returned. This provides
//     a full audit trail even if the response itself is not stored.
//
//  4. RESPONSE WATERMARKING.
//     Every response carries a `_viewed_by` block identifying the
//     staff account, session ID prefix, and timestamp. If a
//     response is leaked, it is traceable to the session that
//     retrieved it.
//
//  5. NO CACHING.
//     Cache-Control: no-store, no-cache on every response.
//     Cloudflare's edge cache will never hold decrypted PII.
//
// ============================================================
//  REQUIRED ENVIRONMENT VARIABLES
// ============================================================
//
//  CORE_DB           — Cloudflare D1 binding
//  FIELD_ENCRYPT_KEY — 64 hex chars; same key used by volunteer.ts
//  APP_ENV           — "development" | "production"
//
// ============================================================

import { can, forbidden } from "../_lib/roles";

interface Env {
  CORE_DB?:          D1Database;
  FIELD_ENCRYPT_KEY?: string;
  APP_ENV?:          string;
}

interface VolunteerRow {
  volunteer_id:  string;
  name:          string | null;
  email:         string | null;
  phone:         string | null;
  zip:           string | null;
  source_form:   string | null;
  verified:      number;
  created_at:    string;
  updated_at:    string;
}

interface InterestRow {
  volunteer_id: string;
  interest:     string;
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}) {
  const { request, env } = context;

  // ── Guard: required config ───────────────────────────────────
  if (!env.CORE_DB)            return jsonError("Database not configured", 500);
  if (!env.FIELD_ENCRYPT_KEY)  return jsonError("Encryption key not configured", 500);

  // ── Auth: validate session ───────────────────────────────────
  const session = await resolveSession(request, env.CORE_DB);
  if (!session) {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Valid staff session required." }),
      {
        status: 401,
        headers: {
          "Content-Type":  "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "WWW-Authenticate": "Bearer realm=\"Staff Portal\""
        }
      }
    );
  }

  const ip     = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(ip);
  const nowIso = new Date().toISOString();

  // ── Route: single record vs. paginated list ──────────────────
  const url    = new URL(request.url);
  const singleId = url.searchParams.get("id");

  // Volunteer records are encrypted PII. Communications and viewer
  // roles have no business reading them, so this is the gate rather
  // than "is signed in".
  if (!can(session.role, "volunteers:read")) {
    return forbidden("volunteers:read", session.role);
  }

	// Bulk export ("download every matching record", not just the page
  // on screen) is a materially different action from browsing a table
  // -- see H6 in the security review. Nothing in the request used to
  // distinguish the two, so anyone with volunteers:read already had
  // export. The frontend's "export all" flow sends ?export=1 when it
  // walks every page; require volunteers:export for that specifically.
  //
  // This is a policy gate, not a hard technical wall: someone with only
  // volunteers:read could still page through everything by hand with a
  // large `limit`. What this closes is the distinction the role table
  // claims to draw actually existing in code, and making bulk export an
  // intentional, checked, auditable action rather than an accident of
  // the API's shape.

	if (url.searchParams.get("export") === "1" && !can(session.role, "volunteers:export")) {
    return forbidden("volunteers:export", session.role);
  }

  // Any uncaught throw is returned by the runtime as a plain-text 500,
  // which the portal can only report as "Server returned 500". Schema
  // problems are by far the most likely cause here, and they need a
  // completely different fix from a genuine server fault -- so name them.
  try {
    if (singleId) {
      return await handleSingleRecord(singleId, session, env, ipHash, nowIso);
    }
    return await handleList(url, session, env, ipHash, nowIso);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("admin-volunteers failed:", detail);

    if (/MISSING_VERIFIED_COLUMN/.test(detail)) {
      return jsonError(
        "The volunteers table has no verification column. Run schema_audit.py " +
        "against this environment \u2014 the Worker log lists the columns it does have.",
        503);
    }
    if (/no such table/i.test(detail)) {
      return jsonError(
        "A required table is missing from this database. Apply the migrations " +
        "in migrations/ to this environment.", 503);
    }
    if (/no such column/i.test(detail)) {
      return jsonError(
        "This database's schema does not match what the portal expects. Run " +
        "schema_audit.py to see what is missing.", 503);
    }
    if (/D1_ERROR|SQLITE/i.test(detail)) {
      return jsonError(
        "The database rejected the request. Check the Worker logs.", 503);
    }
    return jsonError("Failed to load records. Check the Worker logs.", 500);
  }
}

// ============================================================
//  SINGLE RECORD
// ============================================================

async function handleSingleRecord(
  volunteerId: string,
  session: SessionContext,
  env: Env,
  ipHash: string,
  nowIso: string
): Promise<Response> {
  const db = env.CORE_DB!;
  const vcol = await resolveVerifiedColumn(db);

  const row = await db
    .prepare(`SELECT volunteer_id, name, email, phone, zip,
                     source_form, ${vcol} AS verified, created_at, updated_at
              FROM   volunteers
              WHERE  volunteer_id = ?
							AND    deleted_at IS NULL`)
    .bind(volunteerId)
    .first() as VolunteerRow | null;

  if (!row) return jsonError("Volunteer not found", 404);

  // Fetch interests (stored as plaintext — no decryption needed)
  const interestRows = await db
    .prepare(`SELECT interest FROM volunteer_interests WHERE volunteer_id = ?`)
    .bind(volunteerId)
    .all() as { results: { interest: string }[] };

  const decrypted = await decryptVolunteer(row, env.FIELD_ENCRYPT_KEY!);
  decrypted.interests = interestRows.results.map(r => r.interest);

  // Log the access
  await logAccess(db, {
    staffId:     session.staffId,
    sessionId:   session.sessionId,
    action:      "view_volunteer_record",
    ipHash,
    accessedAt:  nowIso,
    recordCount: 1
  });

  return secureJsonResponse({
    volunteer:  decrypted,
    _viewed_by: buildWatermark(session, nowIso)
  });
}

// ============================================================
//  PAGINATED LIST
// ============================================================

async function handleList(
  url: URL,
  session: SessionContext,
  env: Env,
  ipHash: string,
  nowIso: string
): Promise<Response> {
  const db = env.CORE_DB!;

  // Which column holds the verification flag in THIS database.
  const vcol = await resolveVerifiedColumn(db);

  // ── Parse query params ───────────────────────────────────────
  const page      = Math.max(1, parseInt(url.searchParams.get("page")     || "1",   10));
  const limit     = Math.min(100, Math.max(1,
                      parseInt(url.searchParams.get("limit") || "50", 10)));
  const offset    = (page - 1) * limit;

  // Optional filters (all server-side; no plaintext search since fields are encrypted)
  const sourceForm   = url.searchParams.get("source_form") || null;
  const verifiedOnly = url.searchParams.get("verified") === "1";
  const since        = url.searchParams.get("since") || null;   // ISO date lower bound
  const until        = url.searchParams.get("until") || null;   // ISO date upper bound

  // ── Build WHERE clause ───────────────────────────────────────
  const conditions: string[] = [];
  const bindings:   unknown[] = [];

  // Always exclude soft-deleted records. Not user-controlled --
  // there's no legitimate reason for staff to see a volunteer after
  // deletion was requested, so this isn't a filter the caller can opt
  // out of. Every downstream consumer of `where`/`bindings` (the count
  // query, the page query, and handleStats below) inherits this.
  conditions.push("deleted_at IS NULL");

  if (sourceForm) {
    conditions.push("source_form = ?");
    bindings.push(sourceForm);
  }
  if (verifiedOnly) {
    conditions.push(`${vcol} = 1`);
  }
  if (since) {
    conditions.push("created_at >= ?");
    bindings.push(since);
  }
  if (until) {
    conditions.push("created_at <= ?");
    bindings.push(until);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // ── Aggregate statistics ─────────────────────────────────────
  //  ?stats=1 returns counts only — no volunteer rows, no decryption,
  //  no PII of any kind leaves the database.
  //
  //  This exists because the list endpoint is paginated: charts drawn
  //  from a single page would look authoritative while describing 50
  //  of 3,000 records. Aggregating in SQL is both accurate and cheaper
  //  than shipping every row to the browser to count them.
  //
  //  Only unencrypted columns can be grouped this way. source_form,
  //  verified and created_at are stored in the clear; name, email,
  //  phone and zip are AES-GCM ciphertext, so a ZIP-distribution chart
  //  is deliberately absent rather than quietly wrong.
  if (url.searchParams.get("stats") === "1") {
    return await handleStats(db, where, bindings, session, ipHash, vcol);
  }

  // ── Total count ──────────────────────────────────────────────
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM volunteers ${where}`)
    .bind(...bindings)
    .first() as { total: number };

  const total = countRow?.total ?? 0;

  // ── Fetch page ───────────────────────────────────────────────
  const rows = await db
    .prepare(
      `SELECT volunteer_id, name, email, phone, zip,
              source_form, ${vcol} AS verified, created_at, updated_at
       FROM   volunteers
       ${where}
       ORDER  BY created_at DESC
       LIMIT  ? OFFSET ?`
    )
    .bind(...bindings, limit, offset)
    .all() as { results: VolunteerRow[] };

  // ── Decrypt all fields ───────────────────────────────────────
  //    Interests are fetched in a single bulk query to avoid N+1.
  const volunteerIds = rows.results.map(r => r.volunteer_id);

  let interestMap: Record<string, string[]> = {};
  if (volunteerIds.length > 0) {
    const placeholders = volunteerIds.map(() => "?").join(",");
    const interestRows = await db
      .prepare(`SELECT volunteer_id, interest
                FROM   volunteer_interests
                WHERE  volunteer_id IN (${placeholders})`)
      .bind(...volunteerIds)
      .all() as { results: InterestRow[] };

    for (const r of interestRows.results) {
      if (!interestMap[r.volunteer_id]) interestMap[r.volunteer_id] = [];
      interestMap[r.volunteer_id].push(r.interest);
    }
  }

  const decryptedVolunteers = await Promise.all(
    rows.results.map(async row => {
      const dec = await decryptVolunteer(row, env.FIELD_ENCRYPT_KEY!);
      dec.interests = interestMap[row.volunteer_id] || [];
      return dec;
    })
  );

  // ── Log the access ───────────────────────────────────────────
  await logAccess(db, {
    staffId:     session.staffId,
    sessionId:   session.sessionId,
    action:      "view_volunteer_list",
    ipHash,
    accessedAt:  nowIso,
    recordCount: decryptedVolunteers.length
  });

  // ── Respond ──────────────────────────────────────────────────
  return secureJsonResponse({
    volunteers: decryptedVolunteers,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      has_next:    offset + limit < total,
      has_prev:    page > 1
    },
    filters: {
      source_form:   sourceForm,
      verified_only: verifiedOnly,
      since,
      until
    },
    _viewed_by: buildWatermark(session, nowIso)
  });
}

// ============================================================
//  DECRYPT A SINGLE VOLUNTEER ROW
// ============================================================

interface DecryptedVolunteer {
  volunteer_id: string;
  name:         string | null;
  email:        string | null;
  phone:        string | null;
  zip:          string | null;
  source_form:  string | null;
  verified:     boolean;
  created_at:   string;
  updated_at:   string;
  interests:    string[];
}

async function decryptVolunteer(
  row: VolunteerRow,
  keyHex: string
): Promise<DecryptedVolunteer> {
  const [name, email, phone, zip] = await Promise.all([
    safeDecrypt(row.name,  keyHex),
    safeDecrypt(row.email, keyHex),
    safeDecrypt(row.phone, keyHex),
    safeDecrypt(row.zip,   keyHex)
  ]);

  return {
    volunteer_id: row.volunteer_id,
    name,
    email,
    phone,
    zip,
    source_form:  row.source_form,
    verified:     row.verified === 1,
    created_at:   row.created_at,
    updated_at:   row.updated_at,
    interests:    []  // caller populates this
  };
}

/**
 * Decrypt a field that is either null or a proper AES-GCM ciphertext.
 * Returns null if input is null, or a placeholder if decryption fails
 * so one bad row doesn't crash the entire list.
 *
 * NOTE: this deliberately does NOT accept a plaintext "dev:" prefix.
 * Accepting it would mean an unencrypted row could be displayed as if
 * it were fine, hiding the fact that encryption never ran. Rows written
 * before this change will show "[decryption error]" — re-seed them.
 */
async function safeDecrypt(
  value: string | null,
  keyHex: string
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  try {
    return await aesGcmDecrypt(value, keyHex);
  } catch {
    // Return a placeholder so the staff member knows the field exists but failed
    return "[decryption error]";
  }
}

// ============================================================
//  VERIFIED COLUMN RESOLUTION
// ============================================================
//
//  This endpoint reads a "verified" flag, but the public
//  verification flow (api/verify-email.ts) writes a column called
//  "email_verified". Depending on when a given database was
//  created, it may have one, the other, or both -- and querying
//  the wrong name fails the whole request with
//  "no such column", which surfaces as an opaque 500.
//
//  Rather than guess, ask the database. This is deliberately NOT
//  cached in module scope: a Worker only ever binds one database so
//  a cache would be correct in production, but it would also make
//  this untestable and would silently outlive a schema change. A
//  PRAGMA is negligible beside the main query and decrypting 50 rows.
//
//  email_verified is preferred when both exist: it is the one the
//  public form actually maintains, so it is the one that reflects
//  reality.
// ============================================================

async function resolveVerifiedColumn(db: D1Database): Promise<string> {
  const { results } = await db.prepare(`PRAGMA table_info(volunteers)`).all();
  const names = new Set((results ?? []).map((c: any) => c.name));

  // PRAGMA returns an empty list for a table that does not exist rather
  // than failing, so an absent table would otherwise be reported as a
  // missing column -- which needs a completely different fix.
  if (names.size === 0) {
    throw new Error("no such table: volunteers");
  }

  if (names.has("email_verified")) return "email_verified";
  if (names.has("verified"))       return "verified";
  {
    // Neither exists. Say which columns DO, so the fix is obvious.
    throw new Error(
      "MISSING_VERIFIED_COLUMN: the volunteers table has neither " +
      "'email_verified' nor 'verified'. Columns present: " +
      Array.from(names).join(", "));
  }
}

// ============================================================
//  AGGREGATE STATISTICS
// ============================================================

interface StatsBucket { label: string; count: number; }

async function handleStats(
  db: D1Database,
  where: string,
  bindings: unknown[],
  session: SessionContext,
  ipHash: string,
  vcol: string
): Promise<Response> {

  const nowIso = new Date().toISOString();

  // ── Headline counts ─────────────────────────────────────────
  const totals = await db.prepare(`
    SELECT COUNT(*)                                          AS total,
           SUM(CASE WHEN ${vcol} = 1 THEN 1 ELSE 0 END)     AS verified,
           SUM(CASE WHEN phone IS NOT NULL THEN 1 ELSE 0 END) AS with_phone,
           MIN(created_at)                                   AS first_signup,
           MAX(created_at)                                   AS latest_signup
      FROM volunteers ${where}
  `).bind(...bindings).first() as {
    total: number; verified: number; with_phone: number;
    first_signup: string | null; latest_signup: string | null;
  } | null;

  const total    = totals?.total ?? 0;
  const verified = totals?.verified ?? 0;

  // ── Sign-ups per day ────────────────────────────────────────
  //  Returned raw by day; the client buckets into days/weeks/months
  //  depending on the span, so changing the grouping doesn't require
  //  another round trip.
  const daily = await db.prepare(`
    SELECT substr(created_at, 1, 10) AS day,
           COUNT(*)                  AS count,
           SUM(CASE WHEN ${vcol} = 1 THEN 1 ELSE 0 END) AS verified
      FROM volunteers ${where}
     GROUP BY day
     ORDER BY day ASC
  `).bind(...bindings).all();

  // ── Source form breakdown ───────────────────────────────────
  const bySource = await db.prepare(`
    SELECT COALESCE(source_form, 'unknown') AS label,
           COUNT(*)                         AS count
      FROM volunteers ${where}
     GROUP BY label
     ORDER BY count DESC
  `).bind(...bindings).all();

  // ── Interests ───────────────────────────────────────────────
  //  volunteer_interests is a separate unencrypted table, so this
  //  joins rather than decrypting anything.
  const interestWhere = where
    ? where.replace(/\bcreated_at\b/g, "v.created_at")
           .replace(/\bsource_form\b/g, "v.source_form")
           .replace(new RegExp(`\\b${vcol}\\b`, "g"), `v.${vcol}`)
    : "";
  const byInterest = await db.prepare(`
    SELECT i.interest AS label, COUNT(*) AS count
      FROM volunteer_interests i
      JOIN volunteers v ON v.volunteer_id = i.volunteer_id
      ${interestWhere}
     GROUP BY i.interest
     ORDER BY count DESC
     LIMIT 15
  `).bind(...bindings).all();

  await logAccess(db, {
    staffId:     session.staffId,
    sessionId:   session.sessionId,
    action:      "view_volunteer_stats",
    ipHash,
    accessedAt:  nowIso,
    recordCount: 0            // aggregates only — no records were decrypted
  });

  return secureJsonResponse({
    totals: {
      total,
      verified,
      unverified:    total - verified,
      with_phone:    totals?.with_phone ?? 0,
      first_signup:  totals?.first_signup ?? null,
      latest_signup: totals?.latest_signup ?? null
    },
    daily:     (daily.results     ?? []) as Array<{ day: string; count: number; verified: number }>,
    by_source: (bySource.results  ?? []) as StatsBucket[],
    by_interest: (byInterest.results ?? []) as StatsBucket[],
    _viewed_by: buildWatermark(session, nowIso)
  });
}

// ============================================================
//  SESSION RESOLUTION
// ============================================================
//
//  Duplicated here from admin-auth.ts because Cloudflare Pages
//  Functions are self-contained files with no cross-file imports.
//  Keep both copies in sync if you change the validation logic.
//
// ============================================================

interface SessionContext {
  sessionId: string;
  staffId:   string;
  username:  string;
  role:      string;
}

async function resolveSession(
  request: Request,
  db: D1Database
): Promise<SessionContext | null> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) return null;

  const tokenHash = await sha256(rawToken);
  const now       = new Date().toISOString();

  const row = await db
    .prepare(`SELECT s.session_id, s.staff_id, s.ip_hash, s.ua_hash,
                     a.username, a.role
              FROM   staff_sessions s
              JOIN   staff_accounts a ON a.staff_id = s.staff_id
              WHERE  s.token_hash     = ?
                AND  s.invalidated_at IS NULL
                AND  s.expires_at     > ?`)
    .bind(tokenHash, now)
    .first() as {
      session_id: string;
      staff_id:   string;
      ip_hash:    string;
      ua_hash:    string;
      username:   string;
      role:       string;
    } | null;

  if (!row) return null;

  const ip     = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua     = request.headers.get("User-Agent")        || "unknown";
  const ipHash = await sha256(ip);
  const uaHash = await sha256(ua);

  if (ipHash !== row.ip_hash || uaHash !== row.ua_hash) return null;

  return {
    sessionId: row.session_id,
    staffId:   row.staff_id,
    username:  row.username,
    role:      row.role
  };
}

// ============================================================
//  RESPONSE WATERMARK
// ============================================================

/**
 * Embeds identity metadata into every response.
 * If a response is ever leaked or screenshotted, it is
 * traceable back to the specific staff session that retrieved it.
 */
function buildWatermark(session: SessionContext, viewedAt: string) {
  return {
    username:       session.username,
    role:           session.role,
    session_prefix: session.sessionId.slice(0, 8),   // first 8 chars only — not the full ID
    viewed_at:      viewedAt
  };
}

// ============================================================
//  ACCESS LOG HELPER
// ============================================================

async function logAccess(
  db: D1Database,
  opts: {
    staffId:      string;
    sessionId:    string;
    action:       string;
    ipHash:       string;
    accessedAt:   string;
    recordCount?: number;
  }
): Promise<void> {
  await db
    .prepare(`INSERT INTO staff_access_log
                (log_id, staff_id, session_id, action, ip_hash, accessed_at, record_count)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      opts.staffId,
      opts.sessionId,
      opts.action,
      opts.ipHash,
      opts.accessedAt,
      opts.recordCount ?? null
    )
    .run();
}

// ============================================================
//  AES-256-GCM DECRYPT
// ============================================================

async function aesGcmDecrypt(encrypted: string, keyHex: string): Promise<string> {
  const [ivB64, cipherB64] = encrypted.split(".");
  if (!ivB64 || !cipherB64) throw new Error("Invalid encrypted format");

  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const iv         = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(cipherB64);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plainBuffer);
}

// ============================================================
//  ENCODING / CRYPTO UTILITIES
// ============================================================

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(buf));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

// ── Response helpers ──────────────────────────────────────────

/**
 * All responses from this endpoint carry headers that prevent
 * any caching layer (browser, CDN, proxy) from storing the
 * decrypted content.
 */
function secureJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma":        "no-cache",
      "Expires":       "0",
      // Prevent the response from being embedded in iframes
      "X-Frame-Options":        "DENY",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function jsonError(message: string, status = 400): Response {
  return secureJsonResponse({ error: message }, status);
}
