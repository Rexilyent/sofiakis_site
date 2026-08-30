// ============================================================
//  ADMIN VOLUNTEER REMOVAL  —  /api/admin-volunteer-delete
// ============================================================
//
//  Staff-initiated removal of a volunteer record, for requests that
//  arrive by phone, post or in person rather than through the
//  self-service flow at /delete-me.
//
//  POST /api/admin-volunteer-delete
//    { volunteer_id, mode: "soft" | "purge", reason, confirm? }
//
//  All requests require:
//    Authorization: Bearer <session_token>
//
// ============================================================
//  SECURITY MODEL
// ============================================================
//
//  This is a separate file from admin-volunteers.ts on purpose. That
//  endpoint is a hardened read path; bolting a destructive verb onto it
//  means every future change to the reader is also a change to the
//  eraser. Nothing here touches the intake pipeline either.
//
//  1. CAPABILITY, NOT ROLE.
//     Soft delete needs volunteers:delete; purge needs
//     volunteers:purge. Neither asks "is this an admin?". As of writing
//     purge is superadmin-only — see the note on the admin role in
//     _lib/roles.ts, where it is excluded from a subtractive list
//     precisely so it cannot arrive by default.
//
//  2. PURGE REQUIRES A PRIOR SOFT DELETE.
//     A record that has never been marked deleted cannot be erased in
//     one call. This is the whole two-person-ish safety property of the
//     endpoint: erasure is always a second, deliberate act against a
//     record already visibly staged for removal, so a mis-click, a
//     mis-typed ID or a compromised session cannot take the file out in
//     a single request. There is no override flag.
//
//  3. PURGE REQUIRES A TYPED CONFIRMATION.
//     confirm must equal the volunteer_id being erased. A UI cannot
//     supply this by accident, and a replayed request body cannot be
//     retargeted at a different record by editing one field.
//
//  4. NO PII IN, NO PII OUT.
//     The caller passes a volunteer_id, never an email address, and the
//     response carries no decrypted fields. Removing somebody should not
//     require or produce a readout of their details, and it keeps this
//     endpoint off the list of places PII can leak from.
//
//  5. EXPLICIT CHILD DELETES.
//     The child tables declare ON DELETE CASCADE, but a purge that
//     silently left interests, languages or submissions behind would
//     defeat the entire point while reporting success. The rows are
//     deleted by name, child-first, rather than trusting the pragma
//     state of whatever connection this runs on.
//
//  6. EVERY ACTION IS LOGGED TWICE.
//     staff_access_log records who did it (matching the read path's
//     audit trail), and deletion_requests records what was done to whom,
//     alongside the self-service deletions, so there is one place to
//     answer "was this person removed, and by whom?".
//
// ============================================================
//  REQUIRED ENVIRONMENT VARIABLES
// ============================================================
//
//  CORE_DB   — Cloudflare D1 binding
//  APP_ENV   — "development" | "production"
//
//  Note there is no FIELD_ENCRYPT_KEY here, and no FIELD_HMAC_KEY.
//  This endpoint neither reads nor writes any encrypted value.
//
// ============================================================

import { can, forbidden } from "../_lib/roles";

interface Env {
  CORE_DB?: D1Database;
  APP_ENV?: string;
}

/** Reasons are free text, but they are mandatory and bounded. */
const MAX_REASON_LENGTH = 500;

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  const { request, env } = context;

  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  // ── Auth: validate session ───────────────────────────────────
  const session = await resolveSession(request, env.CORE_DB);
  if (!session) {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Valid staff session required." }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "WWW-Authenticate": "Bearer realm=\"Staff Portal\""
        }
      }
    );
  }

  // ── Parse body ───────────────────────────────────────────────
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json", 415);
  }

  interface Body {
    volunteer_id?: string;
    mode?: string;
    reason?: string;
    confirm?: string;
  }

  let body: Body;
  try {
    body = await request.json() as Body;
  } catch {
    return jsonError("Malformed JSON body", 400);
  }

  const volunteerId = typeof body.volunteer_id === "string" ? body.volunteer_id.trim() : "";
  const mode = typeof body.mode === "string" ? body.mode : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!volunteerId) return jsonError("volunteer_id is required", 400);
  if (mode !== "soft" && mode !== "purge") {
    return jsonError('mode must be "soft" or "purge"', 400);
  }

  // A UUID and nothing else. This value is bound as a parameter so it is
  // not an injection risk, but an ID that cannot possibly match is worth
  // rejecting before it reaches the database.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(volunteerId)) {
    return jsonError("volunteer_id is not a valid record ID", 400);
  }

  // Required for both modes. An audit line reading "admin deleted a
  // record, no reason given" is the one that is impossible to answer
  // questions about six months later.
  if (!reason) {
    return jsonError("A reason is required and will be recorded in the audit log", 400);
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return jsonError(`Reason must be ${MAX_REASON_LENGTH} characters or fewer`, 400);
  }

  // ── Capability gate ──────────────────────────────────────────
  const capability = mode === "purge" ? "volunteers:purge" : "volunteers:delete";
  if (!can(session.role, capability)) {
    return forbidden(capability, session.role);
  }

  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "unknown");
  const nowIso = new Date().toISOString();

  try {
    return mode === "purge"
      ? await handlePurge(volunteerId, body.confirm, reason, session, env, ipHash, nowIso)
      : await handleSoftDelete(volunteerId, reason, session, env, ipHash, nowIso);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("admin-volunteer-delete failed:", detail);

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
      return jsonError("The database rejected the request. Check the Worker logs.", 503);
    }
    return jsonError("Failed to remove the record. Check the Worker logs.", 500);
  }
}

// ============================================================
//  SOFT DELETE
// ============================================================
//
//  Stamps deleted_at. The row and its encrypted fields stay put, which
//  is the same semantics the self-service flow uses. Reversible by
//  clearing the column.

async function handleSoftDelete(
  volunteerId: string,
  reason: string,
  session: SessionContext,
  env: Env,
  ipHash: string,
  nowIso: string
): Promise<Response> {
  const db = env.CORE_DB!;

  const row = await db
    .prepare(`SELECT volunteer_id, email_hash, deleted_at
              FROM   volunteers
              WHERE  volunteer_id = ?`)
    .bind(volunteerId)
    .first() as { volunteer_id: string; email_hash: string | null; deleted_at: string | null } | null;

  if (!row) return jsonError("Volunteer not found", 404);

  if (row.deleted_at) {
    return secureJsonResponse({
      success: true,
      already: true,
      message: "That record was already marked deleted. Nothing changed.",
      volunteer_id: volunteerId,
      deleted_at: row.deleted_at,
      _actioned_by: buildWatermark(session, nowIso)
    });
  }

  // Guarded so two staff clicking at once produce one deletion and one
  // "already deleted", rather than two audit lines for one act.
  const res = await db
    .prepare(`UPDATE volunteers
              SET    deleted_at = ?, updated_at = ?
              WHERE  volunteer_id = ? AND deleted_at IS NULL`)
    .bind(nowIso, nowIso, volunteerId)
    .run();

  if (!res?.meta || res.meta.changes !== 1) {
    return jsonError("The record was modified by someone else. Reload and try again.", 409);
  }

  // Outstanding self-service codes for this person now authorise
  // nothing, so retire them rather than leaving live credentials
  // pointing at a deleted record.
  await db
    .prepare(`UPDATE deletion_verifications
              SET    consumed_at = ?
              WHERE  volunteer_id = ? AND consumed_at IS NULL`)
    .bind(nowIso, volunteerId)
    .run();

  await logDeletionRequest(db, {
    volunteerId,
    emailHash: row.email_hash,
    type: "soft",
    actor: session.username,
    reason,
    at: nowIso
  });

  await logAccess(db, {
    staffId: session.staffId,
    sessionId: session.sessionId,
    action: "soft_delete_volunteer",
    ipHash,
    accessedAt: nowIso,
    recordCount: 1
  });

  return secureJsonResponse({
    success: true,
    mode: "soft",
    volunteer_id: volunteerId,
    deleted_at: nowIso,
    message:
      "Record marked deleted. It can still be permanently erased by a " +
      "superadmin, or restored by clearing deleted_at.",
    _actioned_by: buildWatermark(session, nowIso)
  });
}

// ============================================================
//  PURGE
// ============================================================
//
//  Destroys the row and everything hanging off it. No undo.

async function handlePurge(
  volunteerId: string,
  confirm: string | undefined,
  reason: string,
  session: SessionContext,
  env: Env,
  ipHash: string,
  nowIso: string
): Promise<Response> {
  const db = env.CORE_DB!;

  // Typed confirmation. Checked before the lookup so a caller who has
  // not confirmed learns nothing about whether the ID exists.
  if (typeof confirm !== "string" || confirm.trim() !== volunteerId) {
    return jsonError(
      "To permanently erase a record, send the volunteer_id again as `confirm`. " +
      "This is irreversible.",
      400
    );
  }

  const row = await db
    .prepare(`SELECT volunteer_id, email_hash, deleted_at
              FROM   volunteers
              WHERE  volunteer_id = ?`)
    .bind(volunteerId)
    .first() as { volunteer_id: string; email_hash: string | null; deleted_at: string | null } | null;

  if (!row) return jsonError("Volunteer not found", 404);

  // The staging requirement. See point 2 in the header.
  if (!row.deleted_at) {
    return jsonError(
      "That record has not been marked deleted yet. Soft delete it first, " +
      "then erase it. Erasing is deliberately a second step.",
      409
    );
  }

  // Read the email hash out before the row goes, so deletion_requests
  // can still record who this was. The hash is not reversible to an
  // address, but it is what ties this line to the volunteer's other
  // audit records.
  const emailHash = row.email_hash;

    // ── Delete children first, then the parent — atomically ──────
  //  Named explicitly rather than relying on ON DELETE CASCADE. See
  //  point 5 in the header. deletion_verifications is included even
  //  though its rows are inert once consumed — they carry an
  //  email_hash, and erasing somebody should not leave that behind.
  //
  //  db.batch() runs every statement as one atomic transaction. The
  //  previous version issued five sequential .run() calls: if the
  //  isolate died partway through, a purge could leave some child
  //  tables cleared and others (or the parent row itself) still
  //  present — silently defeating the "no orphaned PII" guarantee
  //  this function exists to provide.
  const batchResults = await db.batch([
    db.prepare(`DELETE FROM volunteer_interests    WHERE volunteer_id = ?`).bind(volunteerId),
    db.prepare(`DELETE FROM volunteer_languages    WHERE volunteer_id = ?`).bind(volunteerId),
    db.prepare(`DELETE FROM volunteer_submissions  WHERE volunteer_id = ?`).bind(volunteerId),
    db.prepare(`DELETE FROM deletion_verifications WHERE volunteer_id = ?`).bind(volunteerId),
    db.prepare(`DELETE FROM volunteers             WHERE volunteer_id = ?`).bind(volunteerId),
  ]);

  const removed = batchResults[batchResults.length - 1]?.meta?.changes ?? 0;
	
  // deletion_requests has no foreign key to volunteers, so this line
  // survives the erasure it describes. That is the point of it.
  await logDeletionRequest(db, {
    volunteerId,
    emailHash,
    type: "hard",
    actor: session.username,
    reason,
    at: nowIso
  });

  await logAccess(db, {
    staffId: session.staffId,
    sessionId: session.sessionId,
    action: "purge_volunteer",
    ipHash,
    accessedAt: nowIso,
    recordCount: removed
  });

  return secureJsonResponse({
    success: true,
    mode: "purge",
    volunteer_id: volunteerId,
    rows_removed: removed,
    message: "Record permanently erased. This cannot be undone.",
    _actioned_by: buildWatermark(session, nowIso)
  });
}

// ============================================================
//  DELETION LOG
// ============================================================
//
//  Shared with the public /api/delete-me flow, so staff-initiated and
//  self-service removals sit in one table. actor and reason are added by
//  migration 008; the public flow leaves both NULL, which is how you
//  tell the two apart.

async function logDeletionRequest(
  db: D1Database,
  opts: {
    volunteerId: string;
    emailHash: string | null;
    type: "soft" | "hard";
    actor: string;
    reason: string;
    at: string;
  }
): Promise<void> {
  await db
    .prepare(`INSERT INTO deletion_requests
                (request_id, volunteer_id, email, type, requested_at, processed_at, actor, reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      opts.volunteerId,
      opts.emailHash ?? "",   // the column is NOT NULL; the hash, never plaintext
      opts.type,
      opts.at,
      opts.at,                // staff actions complete immediately
      opts.actor,
      opts.reason
    )
    .run();
}

// ============================================================
//  ACCESS LOG
// ============================================================

async function logAccess(
  db: D1Database,
  opts: {
    staffId: string;
    sessionId: string;
    action: string;
    ipHash: string;
    accessedAt: string;
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
//  SESSION RESOLUTION
// ============================================================
//
//  Third copy of this, after admin-auth.ts and admin-volunteers.ts.
//  Keep all three in sync if the validation logic changes — a session
//  check that drifts on the destructive endpoint is the worst one to
//  get wrong.
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

function buildWatermark(session: SessionContext, actionedAt: string) {
  return {
    username:       session.username,
    role:           session.role,
    session_prefix: session.sessionId.slice(0, 8),
    actioned_at:    actionedAt
  };
}

// ============================================================
//  UTILITIES
// ============================================================

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function secureJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma":        "no-cache",
      "Expires":       "0",
      "X-Frame-Options":        "DENY",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function jsonError(message: string, status = 400): Response {
  return secureJsonResponse({ error: message }, status);
}
