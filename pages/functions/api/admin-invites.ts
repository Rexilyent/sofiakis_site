// ============================================================
//  ADMIN INVITES  —  /api/admin-invites
// ============================================================
//
//  GET    /api/admin-invites          — list invitations
//  POST   /api/admin-invites          — create one and email it
//  DELETE /api/admin-invites?id=<id>  — revoke an unused invitation
//
//  ── AUTHORISATION ─────────────────────────────────────────
//
//  Every route here requires role = "superadmin". This is the
//  first place in the codebase that checks `role` for anything —
//  it is stored on staff_accounts and carried through sessions,
//  but until now nothing read it. Inviting staff is the right
//  place to start: it is the one action that grants another
//  person access to volunteer PII.
//
//  ── WHY INVITES RATHER THAN CREATING ACCOUNTS ─────────────
//
//  An invited person sets their own password, so it is never
//  typed by one person and read by another, never sent over chat
//  or email, and never known to anyone but its owner. The emailed
//  link carries a single-use token that expires; the database
//  stores only its SHA-256 hash, the same way session tokens are
//  handled.
//
// ============================================================

interface Env {
  CORE_DB: D1Database;
  RESEND_API_KEY?: string;
  INVITE_FROM_EMAIL?: string;
  APP_ENV?: string;
}

/** Invitations expire quickly — an unused one is a standing key. */
const INVITE_TTL_HOURS = 72;

const VALID_ROLES = ["viewer", "admin", "superadmin"];

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

  // Role gate. Deliberately 403 rather than 404: the caller is a
  // legitimate staff member, and telling them they lack permission is
  // more useful than pretending the endpoint doesn't exist.
  if (session.role !== "superadmin") {
    return jsonError(
      "Only a superadmin can manage staff invitations.", 403);
  }

  try {
    const url = new URL(request.url);

    switch (request.method) {
      case "GET":
        // ?view=accounts lists existing staff rather than invitations
        return url.searchParams.get("view") === "accounts"
          ? await handleListAccounts(env, session)
          : await handleList(env, session);
      case "POST":   return await handleCreate(request, env, session);
      case "PATCH":  return await handleSetRole(request, env, session);
      case "DELETE": return await handleRevoke(request, env, session);
      default:       return jsonError("Method not allowed", 405);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("admin-invites failed:", detail);
    if (/no such table/i.test(detail)) {
      return jsonError(
        "The invitations table is missing. Apply migrations/003_staff_invites.sql " +
        "to this environment.", 503);
    }
    return jsonError("Invitation request failed. Check the Worker logs.", 500);
  }
}

// ============================================================
//  LIST
// ============================================================

async function handleList(env: Env, session: SessionContext): Promise<Response> {
  const nowIso = new Date().toISOString();

  const { results } = await env.CORE_DB.prepare(`
    SELECT invite_id, email, role, invited_by, created_at, expires_at,
           accepted_at, revoked_at, revoked_by
      FROM staff_invites
     ORDER BY created_at DESC
     LIMIT 200
  `).all();

  // Status is derived rather than stored: a row does not change when
  // it expires, so computing it here keeps the two from disagreeing.
  const invites = (results ?? []).map((row: any) => ({
    ...row,
    status: row.accepted_at ? "accepted"
          : row.revoked_at  ? "revoked"
          : (row.expires_at && row.expires_at < nowIso) ? "expired"
          : "pending"
  }));

  const countBy = (status: string) =>
    invites.filter((i: { status: string }) => i.status === status).length;

  const counts = {
    pending:  countBy("pending"),
    accepted: countBy("accepted"),
    expired:  countBy("expired"),
    revoked:  countBy("revoked")
  };

  await logAccess(env, session, "list_invites", invites.length);

  return secureJson({ invites, counts, email_configured: !!env.RESEND_API_KEY });
}

// ============================================================
//  STAFF ACCOUNTS
// ============================================================
//
//  The portal could show who had been INVITED but not who actually
//  has access, which is the more important question — an invitation
//  is a request, an account is a key.

async function handleListAccounts(env: Env, session: SessionContext): Promise<Response> {
  // password_hash is never selected.
  const { results } = await env.CORE_DB.prepare(`
    SELECT staff_id, username, role, failed_attempts, locked_until,
           last_login_at, created_at
      FROM staff_accounts
     ORDER BY username
  `).all();

  const accounts = (results ?? []).map((row: any) => ({
    ...row,
    is_you: row.username === session.username,
    is_locked: !!(row.locked_until && row.locked_until > new Date().toISOString())
  }));

  const byRole = (r: string) =>
    accounts.filter((a: { role: string }) => a.role === r).length;

  await logAccess(env, session, "list_staff_accounts", accounts.length);

  return secureJson({
    accounts,
    counts: {
      total:      accounts.length,
      superadmin: byRole("superadmin"),
      admin:      byRole("admin"),
      viewer:     byRole("viewer")
    }
  });
}

// ============================================================
//  CHANGE ROLE
// ============================================================

async function handleSetRole(
  request: Request, env: Env, session: SessionContext
): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body", 400);

  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const role     = typeof body.role === "string" ? body.role : "";

  if (!username) return jsonError("Missing username", 400);
  if (!VALID_ROLES.includes(role)) {
    return jsonError(`Role must be one of: ${VALID_ROLES.join(", ")}.`, 400);
  }

  const account = await env.CORE_DB
    .prepare(`SELECT staff_id, username, role FROM staff_accounts WHERE username = ?`)
    .bind(username)
    .first<{ staff_id: string; username: string; role: string }>();

  if (!account) return jsonError("No such staff account.", 404);
  if (account.role === role) {
    return secureJson({ success: true, username, role, unchanged: true });
  }

  // ── The lockout guard ───────────────────────────────────
  //  Removing the last superadmin would leave nobody able to invite
  //  staff or change roles — recoverable only through the break-glass
  //  script. Refuse rather than let someone do it by accident.
  if (account.role === "superadmin" && role !== "superadmin") {
    const row = await env.CORE_DB
      .prepare(`SELECT COUNT(*) AS n FROM staff_accounts WHERE role = 'superadmin'`)
      .first<{ n: number }>();
    if ((row?.n ?? 0) <= 1) {
      return jsonError(
        "This is the only superadmin. Promote someone else first, or nobody " +
        "will be able to manage staff access.", 409);
    }
  }

  await env.CORE_DB
    .prepare(`UPDATE staff_accounts SET role = ? WHERE username = ?`)
    .bind(role, username).run();

  await logAccess(env, session, `set_role:${username}:${account.role}->${role}`, 1);

  return secureJson({
    success: true,
    username,
    role,
    previous_role: account.role,
    // Demoting yourself takes effect on the NEXT request, since the
    // current session already resolved its role. Say so.
    self_demotion: username === session.username && role !== "superadmin"
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

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role  = typeof body.role === "string" ? body.role : "admin";

  if (!isPlausibleEmail(email)) {
    return jsonError("Enter a valid email address.", 400);
  }
  if (!VALID_ROLES.includes(role)) {
    return jsonError(`Role must be one of: ${VALID_ROLES.join(", ")}.`, 400);
  }

  // Inviting someone who already has an account is almost always a
  // mistake — they should reset their password instead.
  const existingAccount = await env.CORE_DB
    .prepare(`SELECT username FROM staff_accounts WHERE username = ?`)
    .bind(email.split("@")[0])
    .first();
  if (existingAccount) {
    return jsonError(
      `An account already exists for "${email.split("@")[0]}". ` +
      "Use a password reset instead of a new invitation.", 409);
  }

  const nowIso = new Date().toISOString();

  // Supersede any outstanding invite to the same address, so two live
  // links can't exist for one person.
  await env.CORE_DB.prepare(`
    UPDATE staff_invites
       SET revoked_at = ?, revoked_by = ?
     WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).bind(nowIso, session.username, email).run();

  // 32 random bytes, hex encoded. Only the hash is stored.
  const token     = generateToken();
  const tokenHash = await sha256Hex(token);
  const inviteId  = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000).toISOString();

  await env.CORE_DB.prepare(`
    INSERT INTO staff_invites
      (invite_id, email, token_hash, role, invited_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(inviteId, email, tokenHash, role, session.username, nowIso, expiresAt).run();

  const origin    = new URL(request.url).origin;
  const signupUrl = `${origin}/staff-signup.html?token=${token}`;

  // ── Send it ─────────────────────────────────────────────
  let emailed = false;
  let emailError: string | null = null;

  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: env.INVITE_FROM_EMAIL || "no-reply@alexandriasofiakis.com",
          to: email,
          subject: "You've been invited to the Alexandria Sofiakis staff portal",
          html: inviteEmailHtml(signupUrl, session.username, role)
        })
      });
      if (res.ok) {
        emailed = true;
      } else {
        emailError = `Resend returned ${res.status}`;
        console.error("Invite email failed:", await res.text());
      }
    } catch (err) {
      emailError = "Could not reach the email service";
      console.error("Invite email threw:", err);
    }
  } else {
    emailError = "RESEND_API_KEY is not configured";
  }

  await logAccess(env, session, `create_invite:${email}`, 1);

  // The link is returned regardless of whether the email went out, so
  // a mail failure never blocks onboarding — it can be passed along
  // by another channel. This is why the endpoint is superadmin-only.
  return secureJson({
    success: true,
    invite_id: inviteId,
    email,
    role,
    expires_at: expiresAt,
    emailed,
    email_error: emailError,
    signup_url: signupUrl
  }, 201);
}

function inviteEmailHtml(url: string, invitedBy: string, role: string): string {
  return `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
                max-width:520px;margin:0 auto;color:#111;line-height:1.6">
      <h2 style="color:#008037;margin-bottom:0.25rem">Alexandria Sofiakis for IL-10</h2>
      <p style="color:#6E6E6E;margin-top:0">Staff portal invitation</p>
      <p><strong>${escapeHtml(invitedBy)}</strong> has invited you to the campaign
         staff portal as <strong>${escapeHtml(role)}</strong>.</p>
      <p>Choose your own username and password using the link below. Nobody else
         will see the password you pick.</p>
      <p style="margin:1.5rem 0">
        <a href="${url}"
           style="background:#008037;color:#fff;padding:0.75rem 1.5rem;
                  border-radius:8px;text-decoration:none;font-weight:600;
                  display:inline-block">Set up your account</a>
      </p>
      <p style="font-size:0.9rem;color:#6E6E6E">
        This link works once and expires in ${INVITE_TTL_HOURS} hours.
        If you weren't expecting it, you can ignore this email — no account
        is created until the link is used.
      </p>
      <p style="font-size:0.8rem;color:#999;border-top:1px solid #eee;padding-top:1rem">
        Paid for by Alexandria Sofiakis for IL-10
      </p>
    </div>`;
}

// ============================================================
//  REVOKE
// ============================================================

async function handleRevoke(
  request: Request, env: Env, session: SessionContext
): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonError("Missing invitation id", 400);

  const invite = await env.CORE_DB
    .prepare(`SELECT invite_id, email, accepted_at, revoked_at
                FROM staff_invites WHERE invite_id = ?`)
    .bind(id)
    .first<{ invite_id: string; email: string; accepted_at: string | null; revoked_at: string | null }>();

  if (!invite) return jsonError("Invitation not found", 404);

  // An accepted invite has already produced an account; revoking it
  // would imply removing that access, which it does not do.
  if (invite.accepted_at) {
    return jsonError(
      "That invitation was already used. Delete the account instead if you " +
      "want to remove access.", 409);
  }
  if (invite.revoked_at) {
    return secureJson({ success: true, already_revoked: true });
  }

  await env.CORE_DB.prepare(`
    UPDATE staff_invites SET revoked_at = ?, revoked_by = ? WHERE invite_id = ?
  `).bind(new Date().toISOString(), session.username, id).run();

  await logAccess(env, session, `revoke_invite:${invite.email}`, 1);

  return secureJson({ success: true, invite_id: id });
}

// ============================================================
//  HELPERS
// ============================================================

/**
 * Deliberately permissive. Real address validity is proven by the
 * invitation arriving, not by a regex; over-strict patterns reject
 * valid addresses and frustrate the person sending the invite.
 */
function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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
//  Duplicated from admin-auth.ts, matching the convention used by
//  admin-volunteers.ts, admin-calendar.ts and admin-articles.ts.
//  Keep all copies in sync.
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
