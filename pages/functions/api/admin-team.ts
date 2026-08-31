// ============================================================
//  ADMIN TEAM  —  /api/admin-team
// ============================================================
//
//  GET    /api/admin-team              — the directory, with access status
//  POST   /api/admin-team              — add a person
//  PATCH  /api/admin-team              — update a person
//  DELETE /api/admin-team?id=<id>      — remove a person
//
//  ── WHO CAN DO WHAT ───────────────────────────────────────
//
//  Reading the directory: any signed-in staff member. Knowing who
//  your colleagues are and what they do is ordinary information,
//  and hiding it would just push people to keep private lists.
//
//  Changing it: the team:write capability (admin and superadmin
//  roles). The directory drives portal invitations, so write access
//  to it is held to a higher bar than most operational data.
//
//  ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────
//
//  It does not grant portal access. Adding someone here creates a
//  record, nothing more. Access is granted by sending them an
//  invitation through /api/admin-invites, which they must accept
//  by choosing their own password. Keeping those separate means a
//  typo in the directory can never hand anyone a login.
//
//  The one exception is the staff_username LINK itself: a team:write
//  caller can point a directory row at an EXISTING staff_accounts
//  row, or clear that pointer. This is normally set automatically
//  (matched on email when an invite is accepted) but has no way to
//  happen if the invite went out directly and no team_members row
//  existed yet to match against. Linking never creates an account or
//  grants anything new — the account must already exist — it only
//  repairs or changes which existing account a row points at.
//
// ============================================================

import { can, forbidden } from "../_lib/roles";

interface Env {
  CORE_DB: D1Database;
}

const VALID_STATUS      = ["prospect", "onboarding", "active", "former"];
const VALID_ENGAGEMENT  = ["staff", "volunteer", "contractor", "intern"];
const VALID_TEAMS       = ["field", "comms", "finance", "operations", "digital", "other"];

const MAX_NAME  = 120;
const MAX_TITLE = 120;
const MAX_NOTES = 2000;

// ============================================================
//  ROUTING
// ============================================================

export async function onRequest(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  const session = await resolveSession(request, env.CORE_DB);
  if (!session) return jsonError("Unauthorized", 401);

  try {
    // Knowing who your colleagues are is ordinary information; hiding
    // it just pushes people to keep private lists.
    if (!can(session.role, "team:read")) {
      return forbidden("team:read", session.role);
    }
    if (request.method === "GET") return await handleList(env, session);

    // Editing the directory drives who gets invited, so it is held
    // to the same bar as granting access itself.
    if (!can(session.role, "team:write")) {
      return forbidden("team:write", session.role);
    }

    switch (request.method) {
      case "POST":   return await handleCreate(request, env, session);
      case "PATCH":  return await handleUpdate(request, env, session);
      case "DELETE": return await handleDelete(request, env, session);
      default:       return jsonError("Method not allowed", 405);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("admin-team failed:", detail);
    if (/no such table/i.test(detail)) {
      return jsonError(
        "The team directory table is missing. Apply migrations/004_team.sql " +
        "to this environment.", 503);
    }
    return jsonError("Team directory request failed. Check the Worker logs.", 500);
  }
}

// ============================================================
//  LIST
// ============================================================

async function handleList(env: Env, session: SessionContext): Promise<Response> {
  const nowIso = new Date().toISOString();

  const { results: members } = await env.CORE_DB.prepare(`
    SELECT member_id, full_name, email, phone, title, team, engagement,
           status, started_at, ended_at, notes, staff_username,
           created_at, updated_at, updated_by
      FROM team_members
     ORDER BY
       CASE status WHEN 'active' THEN 0 WHEN 'onboarding' THEN 1
                   WHEN 'prospect' THEN 2 ELSE 3 END,
       full_name
  `).all();

  // Portal access is derived rather than stored, so it can't drift out
  // of step with the accounts and invitations it describes.
  const { results: accounts } = await env.CORE_DB
    .prepare(`SELECT username, role, last_login_at FROM staff_accounts`).all();
  interface AccountRow { username: string; role: string; last_login_at: string | null; }
  const accountByName = new Map<string, AccountRow>(
    (accounts ?? []).map((a: any) => [a.username as string, a as AccountRow]));

  interface InviteRow { email: string; role: string; expires_at: string; }
  let openInvites = new Map<string, InviteRow>();
  try {
    const { results: invites } = await env.CORE_DB.prepare(`
      SELECT email, role, expires_at FROM staff_invites
       WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).bind(nowIso).all();
    openInvites = new Map<string, InviteRow>(
      (invites ?? []).map((i: any) => [String(i.email).toLowerCase(), i as InviteRow]));
  } catch {
    // staff_invites may not exist yet; the directory still works.
  }

  const enriched = (members ?? []).map((m: any) => {
    const account = m.staff_username ? accountByName.get(m.staff_username) : null;
    const invite  = m.email ? openInvites.get(String(m.email).toLowerCase()) : null;

    return {
      ...m,
      portal_access: account ? "active" : invite ? "invited" : "none",
      portal_role:   account?.role ?? invite?.role ?? null,
      last_login_at: account?.last_login_at ?? null,
      invite_expires_at: invite?.expires_at ?? null,
      // A username recorded here with no matching account means the
      // login was deleted. Surface it rather than showing "active".
      orphaned_link: !!(m.staff_username && !account)
    };
  });

  const countBy = (field: string, value: string) =>
    enriched.filter((m: any) => m[field] === value).length;

  await logAccess(env, session, "list_team", enriched.length);

  // Accounts nobody has claimed yet, for the "link to a staff account"
  // control in the edit modal. Only computed for callers who could
  // actually use it — team:write, same bar as editing anything else
  // in the directory. Note this is a smaller exposure than it looks:
  // the username of an ALREADY-linked account is visible to any
  // team:read caller below (it's part of `enriched`), so this just
  // extends that to unclaimed ones, for people who can already write.
  const canWrite = can(session.role, "team:write");
  let linkableAccounts: { username: string; role: string }[] = [];
  if (canWrite) {
    const claimed = new Set(
      (members ?? []).map((m: any) => m.staff_username).filter(Boolean)
    );
    linkableAccounts = (accounts ?? [])
      .filter((a: any) => !claimed.has(a.username))
      .map((a: any) => ({ username: a.username, role: a.role }));
  }

  return secureJson({
    members: enriched,
    counts: {
      total:        enriched.length,
      active:       countBy("status", "active"),
      onboarding:   countBy("status", "onboarding"),
      former:       countBy("status", "former"),
      with_access:  countBy("portal_access", "active"),
      invited:      countBy("portal_access", "invited")
    },
    // The client hides the write controls for non-superadmins; the
    // server enforces it regardless.
    can_edit: canWrite,
    // Empty for callers who can't write anyway.
    linkable_accounts: linkableAccounts
  });
}

// ============================================================
//  CREATE
// ============================================================

async function handleCreate(
  request: Request, env: Env, session: SessionContext
): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body", 400);

  const parsed = validate(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);
  const m = parsed.value;

  // Warn rather than block: two people can legitimately share an
  // address (a shared role inbox), but it is usually a duplicate.
  if (m.email) {
    const existing = await env.CORE_DB
      .prepare(`SELECT full_name FROM team_members WHERE lower(email) = ?`)
      .bind(m.email).first<{ full_name: string }>();
    if (existing) {
      return jsonError(
        `${existing.full_name} is already listed with that email address. ` +
        "Edit their record instead of adding a second one.", 409);
    }
  }

  const memberId = crypto.randomUUID();
  const nowIso   = new Date().toISOString();

  await env.CORE_DB.prepare(`
    INSERT INTO team_members
      (member_id, full_name, email, phone, title, team, engagement, status,
       started_at, ended_at, notes, staff_username,
       created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    memberId, m.full_name, m.email, m.phone, m.title, m.team, m.engagement,
    m.status, m.started_at, m.ended_at, m.notes, null,
    nowIso, nowIso, session.username, session.username
  ).run();

  await logAccess(env, session, `create_team_member:${m.full_name}`, 1);

  return secureJson({ success: true, member_id: memberId, full_name: m.full_name }, 201);
}

// ============================================================
//  UPDATE
// ============================================================

async function handleUpdate(
  request: Request, env: Env, session: SessionContext
): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body", 400);

  const memberId = typeof body.member_id === "string" ? body.member_id : "";
  if (!memberId) return jsonError("Missing member_id", 400);

  const current = await env.CORE_DB
    .prepare(`SELECT member_id, full_name, staff_username FROM team_members WHERE member_id = ?`)
    .bind(memberId).first<{ member_id: string; full_name: string; staff_username: string | null }>();
  if (!current) return jsonError("No such team member.", 404);

  const parsed = validate(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);
  const m = parsed.value;

  // staff_username is normally set automatically, matched on email
  // when someone accepts an invitation. This lets it be set or
  // cleared by hand too, for when an invite went out directly (by
  // email, or via staff_account.py) and no team_members row existed
  // yet for the match to attach to. Only touched when the caller
  // explicitly sends the key, so a request that doesn't know about it
  // (an older client, a script) can never detach someone from their
  // login just by omitting a field.
  let staffUsername = current.staff_username;
  let linkChanged = false;
  if (Object.prototype.hasOwnProperty.call(body, "staff_username")) {
    const link = await resolveStaffUsernameLink(
      body.staff_username, memberId, current.staff_username, env);
    if ("error" in link) return jsonError(link.error, link.status ?? 400);
    staffUsername = link.value;
    linkChanged = staffUsername !== current.staff_username;
  }

  await env.CORE_DB.prepare(`
    UPDATE team_members
       SET full_name = ?, email = ?, phone = ?, title = ?, team = ?,
           engagement = ?, status = ?, started_at = ?, ended_at = ?,
           notes = ?, staff_username = ?, updated_at = ?, updated_by = ?
     WHERE member_id = ?
  `).bind(
    m.full_name, m.email, m.phone, m.title, m.team, m.engagement,
    m.status, m.started_at, m.ended_at, m.notes, staffUsername,
    new Date().toISOString(), session.username, memberId
  ).run();

  if (linkChanged) {
    await logAccess(
      env, session,
      `link_team_member:${memberId}:${current.staff_username ?? "none"}->${staffUsername ?? "none"}`,
      1);
  }
  await logAccess(env, session, `update_team_member:${m.full_name}`, 1);

  return secureJson({
    success: true,
    member_id: memberId,
    // Marking someone former does NOT revoke their login: that is a
    // separate, deliberate act. Tell the caller so it can prompt.
    // Uses the just-saved value, not the old one — clearing the link
    // and marking someone former in the same request should not warn
    // about access that no longer exists.
    still_has_access: m.status === "former" && !!staffUsername
      ? staffUsername : null
  });
}

/**
 * Validate a requested change to staff_username.
 *
 *   "" / not a string  -> clears the link (explicit unlink)
 *   unchanged           -> passed through WITHOUT re-checking the
 *                          account still exists, so an already
 *                          orphaned link (the account behind it was
 *                          deleted) can be saved untouched by an
 *                          unrelated edit instead of being rejected
 *   anything else        -> must name a real staff_accounts row, and
 *                          that row must not already be claimed by a
 *                          DIFFERENT team member
 */
async function resolveStaffUsernameLink(
  raw: unknown, memberId: string, previous: string | null, env: Env
): Promise<{ value: string | null } | { error: string; status?: number }> {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (!value) return { value: null };
  if (value === previous) return { value };

  const account = await env.CORE_DB
    .prepare(`SELECT username FROM staff_accounts WHERE username = ?`)
    .bind(value).first<{ username: string }>();
  if (!account) {
    return { error: `No staff account called "${value}" exists.` };
  }

  const claimedBy = await env.CORE_DB
    .prepare(`SELECT full_name FROM team_members WHERE staff_username = ? AND member_id != ?`)
    .bind(value, memberId).first<{ full_name: string }>();
  if (claimedBy) {
    return {
      error: `"${value}" is already linked to ${claimedBy.full_name}. Unlink them first.`,
      status: 409
    };
  }

  return { value };
}

// ============================================================
//  DELETE
// ============================================================

async function handleDelete(
  request: Request, env: Env, session: SessionContext
): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonError("Missing member id", 400);

  const member = await env.CORE_DB
    .prepare(`SELECT full_name, staff_username FROM team_members WHERE member_id = ?`)
    .bind(id).first<{ full_name: string; staff_username: string | null }>();
  if (!member) return jsonError("No such team member.", 404);

  // Removing the record does not remove the login, and quietly leaving
  // an orphaned account behind is exactly how access outlives people.
  if (member.staff_username) {
    return jsonError(
      `${member.full_name} still has portal access as "${member.staff_username}". ` +
      "Remove their login first, or mark them as former instead of deleting " +
      "the record.", 409);
  }

  await env.CORE_DB.prepare(`DELETE FROM team_members WHERE member_id = ?`).bind(id).run();
  await logAccess(env, session, `delete_team_member:${member.full_name}`, 1);

  return secureJson({ success: true });
}

// ============================================================
//  VALIDATION
// ============================================================

type ValidMember = {
  full_name: string; email: string | null; phone: string | null;
  title: string | null; team: string; engagement: string; status: string;
  started_at: string | null; ended_at: string | null; notes: string | null;
};

function validate(
  body: Record<string, unknown>
): { value: ValidMember } | { error: string } {

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  if (!fullName) return { error: "A name is required." };
  if (fullName.length > MAX_NAME) {
    return { error: `Name must be ${MAX_NAME} characters or fewer.` };
  }

  let email: string | null = null;
  if (typeof body.email === "string" && body.email.trim()) {
    email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      return { error: "That does not look like a valid email address." };
    }
  }

  const status = typeof body.status === "string" && VALID_STATUS.includes(body.status)
    ? body.status : "active";
  const engagement = typeof body.engagement === "string" && VALID_ENGAGEMENT.includes(body.engagement)
    ? body.engagement : "staff";
  const team = typeof body.team === "string" && VALID_TEAMS.includes(body.team)
    ? body.team : "other";

  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (notes.length > MAX_NOTES) {
    return { error: `Notes must be ${MAX_NOTES} characters or fewer.` };
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE) : "";

  const parseDate = (v: unknown): string | null => {
    if (typeof v !== "string" || !v.trim()) return null;
    const d = new Date(v.length === 10 ? `${v}T12:00:00Z` : v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  const startedAt = parseDate(body.started_at);
  const endedAt   = parseDate(body.ended_at);

  if (startedAt && endedAt && endedAt < startedAt) {
    return { error: "The end date is before the start date." };
  }
  if (status === "former" && !endedAt) {
    // Not fatal, but a former member with no end date makes the
    // directory useless for answering "who was here in March".
    return { error: "Give an end date when marking someone as former." };
  }

  return {
    value: {
      full_name: fullName,
      email,
      phone: typeof body.phone === "string" && body.phone.trim()
        ? body.phone.trim().slice(0, 40) : null,
      title: title || null,
      team, engagement, status,
      started_at: startedAt,
      ended_at: endedAt,
      notes: notes || null
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
    `).bind(crypto.randomUUID(), session.staffId, session.sessionId,
            action, "", new Date().toISOString(), count).run();
  } catch (err) {
    console.error("Failed to write access log:", err);
  }
}

// ============================================================
//  SESSION RESOLUTION
// ============================================================
//  Duplicated from admin-auth.ts, matching the convention used by the
//  other admin-* endpoints. Keep all copies in sync.
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

  const row = await db.prepare(`
    SELECT s.session_id, s.staff_id, s.ip_hash, s.ua_hash, a.username, a.role
      FROM staff_sessions s
      JOIN staff_accounts a ON a.staff_id = s.staff_id
     WHERE s.token_hash = ?
       AND s.invalidated_at IS NULL
       AND s.expires_at > ?
       AND a.disabled_at IS NULL
  `).bind(await sha256Hex(token), new Date().toISOString())
    .first<{ session_id: string; staff_id: string; ip_hash: string;
             ua_hash: string; username: string; role: string }>();

  if (!row) return null;

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
    .map(b => b.toString(16).padStart(2, "0")).join("");
}
