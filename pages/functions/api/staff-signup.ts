// ============================================================
//  STAFF SIGNUP  —  /api/staff-signup
// ============================================================
//
//  GET  /api/staff-signup?token=<t>  — is this invitation usable?
//  POST /api/staff-signup            — accept it, creating the account
//
//  ── THIS ENDPOINT IS UNAUTHENTICATED ──────────────────────
//
//  It has to be: the person using it has no account yet. The
//  invitation token is the entire credential, so:
//
//    • the token is 32 random bytes, and only its SHA-256 is stored
//    • it is single-use — accepted_at is set inside the same request
//      that creates the account
//    • it expires (72h by default)
//    • the ROLE comes from the invite row, never from the request
//      body, so an invitee cannot promote themselves to superadmin
//    • a bad token gets the same generic answer whether it is
//      unknown, expired, revoked or already used, so this cannot be
//      used to probe which tokens exist
//
//  The email address is not returned by the GET either. Showing
//  "you are signing up as alex@example.com" would let anyone
//  holding a link learn an address they may not already know.
//
// ============================================================

interface Env {
  CORE_DB: D1Database;
  APP_ENV?: string;
}

const MIN_PASSWORD_LENGTH = 12;
const PBKDF2_ITERATIONS   = 100_000;   // must match admin-auth.ts

export async function onRequest(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  try {
    if (request.method === "GET")  return await handleCheck(request, env);
    if (request.method === "POST") return await handleAccept(request, env);
    return jsonError("Method not allowed", 405);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("staff-signup failed:", detail);
    if (/no such table/i.test(detail)) {
      return jsonError(
        "The invitations table is missing. Apply migrations/003_staff_invites.sql.", 503);
    }
    return jsonError("Sign-up failed. Please contact the campaign technical team.", 500);
  }
}

// ============================================================
//  CHECK
// ============================================================

async function handleCheck(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  const invite = await lookupUsableInvite(token, env);

  if (!invite) {
    // One message for every failure mode, on purpose.
    return secureJson({
      valid: false,
      error: "This invitation link is not valid. It may have expired, already " +
             "been used, or been cancelled. Ask the campaign for a new one."
    });
  }

  // Role is shown because the person should know what they're accepting.
  // The email address is not — see the note at the top of this file.
  return secureJson({
    valid: true,
    role: invite.role,
    expires_at: invite.expires_at,
    min_password_length: MIN_PASSWORD_LENGTH
  });
}

// ============================================================
//  ACCEPT
// ============================================================

async function handleAccept(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid request body", 400);

  const token    = typeof body.token === "string" ? body.token : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const invite = await lookupUsableInvite(token, env);
  if (!invite) {
    return jsonError(
      "This invitation link is not valid. It may have expired, already been " +
      "used, or been cancelled. Ask the campaign for a new one.", 400);
  }

  // ── Username ────────────────────────────────────────────
  // Lowercase enforced because admin-auth lowercases before its
  // lookup; a stored capital would make the account unreachable.
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return jsonError(
      "Username must be 3–32 characters: letters, numbers, dot, underscore or hyphen.",
      400);
  }

  const taken = await env.CORE_DB
    .prepare(`SELECT username FROM staff_accounts WHERE username = ?`)
    .bind(username).first();
  if (taken) {
    return jsonError("That username is already taken. Please choose another.", 409);
  }

  // ── Password ────────────────────────────────────────────
  const problems = passwordProblems(password);
  if (problems.length) {
    return jsonError(`Password ${problems.join(", and ")}.`, 400);
  }

  // ── Create the account ──────────────────────────────────
  const staffId = `staff-${crypto.randomUUID()}`;
  const nowIso  = new Date().toISOString();
  const hash    = await hashPassword(password);

  // Burn the invite FIRST, and check the write actually landed, before
  // creating anything. The previous order -- insert the account, then
  // UPDATE ... WHERE accepted_at IS NULL -- let two concurrent requests
  // carrying the same token both pass lookupUsableInvite before either
  // write landed, so both created accounts at the invited role. The
  // second UPDATE then quietly matched zero rows, leaving that second
  // account invisible in the invitation trail (see H7 in the security
  // review). A D1 UPDATE that matches nothing doesn't throw -- it just
  // reports meta.changes: 0 -- so this has to be an explicit check
  // between two sequential statements, not something db.batch() can
  // paper over: batching the burn and the insert together would still
  // let the losing request's insert run, since a 0-row UPDATE isn't a
  // batch failure.
  const claim = await env.CORE_DB.prepare(`
    UPDATE staff_invites
       SET accepted_at = ?, accepted_staff_id = ?
     WHERE invite_id = ? AND accepted_at IS NULL
  `).bind(nowIso, staffId, invite.invite_id).run();

  if ((claim.meta?.changes ?? 0) === 0) {
    // Someone else's request won the race (or revoked/expired between
    // lookupUsableInvite above and this UPDATE). Same generic message
    // as every other invalid-invite path -- this shouldn't be
    // distinguishable from "the token was just bad".
    return jsonError(
      "This invitation link is not valid. It may have expired, already been " +
      "used, or been cancelled. Ask the campaign for a new one.", 400);
  }

  try {
    await env.CORE_DB.prepare(`
      INSERT INTO staff_accounts
        (staff_id, username, password_hash, role, failed_attempts, locked_until, created_at)
      VALUES (?, ?, ?, ?, 0, NULL, ?)
    `).bind(staffId, username, hash, invite.role, nowIso).run();
  } catch (err) {
    // We already won the invite claim above, so an insert failure here
    // (most likely the UNIQUE constraint on username -- two different
    // tokens racing for the same desired username) must not strand the
    // invite in a claimed-but-unusable state. Roll it back to unaccepted,
    // scoped to our own claim so this can never clobber a different,
    // legitimate acceptance.
    await env.CORE_DB.prepare(`
      UPDATE staff_invites
         SET accepted_at = NULL, accepted_staff_id = NULL
       WHERE invite_id = ? AND accepted_staff_id = ?
    `).bind(invite.invite_id, staffId).run();

    const detail = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed.*username/i.test(detail)) {
      return jsonError("That username is already taken. Please choose another.", 409);
    }
    throw err; // anything else falls through to onRequest's generic 500
  }

  // Link the new login to their team record, if they have one. Matched
  // on the INVITED address rather than anything the signer-up typed, so
  // accepting an invitation cannot attach you to someone else's record.
  //
  // Best-effort: the directory is optional, and failing to link must
  // never cost someone the account they just created.
  try {
    await env.CORE_DB.prepare(`
      UPDATE team_members
         SET staff_username = ?, updated_at = ?
       WHERE lower(email) = ? AND staff_username IS NULL
    `).bind(username, nowIso, invite.email.toLowerCase()).run();
  } catch (err) {
    console.error("Could not link team member to new account:", err);
  }

  try {
    await env.CORE_DB.prepare(`
      INSERT INTO staff_access_log
        (log_id, staff_id, session_id, action, ip_hash, accessed_at, record_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), staffId, "", `invite_accepted:${username}`,
            "", nowIso, 1).run();
  } catch (err) {
    console.error("Failed to log invite acceptance:", err);
  }

  // No session is issued here. The person signs in normally, which
  // proves the password works before they rely on it.
  return secureJson({
    success: true,
    username,
    role: invite.role,
    message: "Your account is ready. Sign in with your new username and password."
  }, 201);
}

// ============================================================
//  SHARED
// ============================================================

interface UsableInvite {
  invite_id: string;
  email: string;
  role: string;
  expires_at: string;
}

/**
 * Return the invite only if it is genuinely usable. Every rejection
 * path returns null so the caller cannot distinguish between them.
 */
async function lookupUsableInvite(token: string, env: Env): Promise<UsableInvite | null> {
  // Cheap shape check first: avoids a database round trip for junk,
  // and the token is a fixed-length hex string by construction.
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const row = await env.CORE_DB.prepare(`
    SELECT invite_id, email, role, expires_at, accepted_at, revoked_at
      FROM staff_invites
     WHERE token_hash = ?
  `).bind(await sha256Hex(token))
    .first<{ invite_id: string; email: string; role: string; expires_at: string;
             accepted_at: string | null; revoked_at: string | null }>();

  if (!row) return null;
  if (row.accepted_at) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;

  return {
    invite_id: row.invite_id,
    email: row.email,
    role: row.role,
    expires_at: row.expires_at
  };
}

/** Advisory checks, returned together so the person fixes them in one go. */
function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 200) {
    problems.push("must be under 200 characters");
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password)
  ].filter(Boolean).length;
  if (classes < 3) {
    problems.push("must mix at least three of: lowercase, uppercase, numbers, symbols");
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push("cannot be a single repeated character");
  }
  return problems;
}

// ============================================================
//  CRYPTO — must match admin-auth.ts exactly
// ============================================================

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial, 256);
  return `${bytesToHex(salt)}:${PBKDF2_ITERATIONS}:${bytesToHex(new Uint8Array(bits))}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
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
