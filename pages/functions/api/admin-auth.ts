// ============================================================
//  ADMIN AUTHENTICATION  —  /api/admin-auth
// ============================================================
//
//  Handles staff login and logout.
//
//  POST  /api/admin-auth   — authenticate with username + password
//                            returns a short-lived session token
//  DELETE /api/admin-auth  — invalidate the current session (logout)
//
// ============================================================
//  REQUIRED ENVIRONMENT VARIABLES (Cloudflare Worker Secrets)
// ============================================================
//
//  CORE_DB               — Cloudflare D1 database binding
//  APP_ENV               — "development" | "production"
//
//  SESSION_DURATION_HOURS (optional, default: 8)
//    — How many hours a session token stays valid.
//
//  MAX_LOGIN_ATTEMPTS (optional, default: 5)
//    — Failed attempts before a username is locked for LOCKOUT_MINUTES.
//
//  LOCKOUT_MINUTES (optional, default: 15)
//    — Minutes a username stays locked after too many failures.
//
// ============================================================
//  HOW SESSION TOKENS WORK
// ============================================================
//
//  1. A cryptographically random 32-byte token is generated.
//  2. Its SHA-256 hash is stored in staff_sessions.token_hash.
//     The raw token is NEVER written to the database.
//  3. The raw token is returned to the client exactly once.
//     All subsequent requests send it in the Authorization header:
//       Authorization: Bearer <token>
//  4. Each request hashes the incoming token and looks up the hash.
//     An attacker with read-only DB access cannot reconstruct tokens.
//  5. Sessions are bound to the IP + User-Agent at login time.
//     A token replayed from a different client will be rejected.
//  6. Logout sets invalidated_at, rendering the token useless even
//     if it hasn't expired yet.
//
// ============================================================
//  HOW PASSWORDS ARE STORED
// ============================================================
//
//  Passwords are hashed with PBKDF2-SHA-256 (600,000 iterations)
//  and a unique 16-byte random salt per account.
//  Stored format:  <hex(salt)>:<iterations>:<hex(hash)>
//
//  To create a staff account, run admin-create-staff.ts or insert
//  a pre-computed row directly into the staff_accounts table via
//  the D1 console / wrangler CLI.
//
// ============================================================

interface Env {
  CORE_DB?: D1Database;
  APP_ENV?: string;
  SESSION_DURATION_HOURS?: string;
  MAX_LOGIN_ATTEMPTS?: string;
  LOCKOUT_MINUTES?: string;
  /** Set to "1" to return exception messages to the client. Diagnostics only. */
  DEBUG_ERRORS?: string;
}

export async function onRequest(context: {
  request: Request;
  env: Env;
}) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  // Any uncaught throw here is returned by the runtime as a plain-text
  // 500, which the login page can only report as "the login service
  // returned an error". Catching it means the browser gets JSON with a
  // usable hint, and the real message still goes to the Worker log.
  try {
    if (method === "POST")   return await handleLogin(request, env);
    if (method === "DELETE") return await handleLogout(request, env);
    return jsonError("Method not allowed", 405);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("admin-auth failed:", detail);

    // A missing table is a setup problem, not a credentials problem,
    // and it is worth saying so plainly -- the alternative is someone
    // retyping a correct password over and over. The table name is
    // deliberately NOT echoed to the browser: this endpoint is public.
    if (/no such table/i.test(detail)) {
      return jsonError(
        "The staff portal database is not fully set up. Apply the migrations " +
        "in migrations/ to this environment, then try again.", 503);
    }
    if (/no such column/i.test(detail)) {
      return jsonError(
        "The staff portal database schema is out of date. Run schema_audit.py " +
        "against this environment to see what is missing.", 503);
    }
    if (/STORED_HASH_ITERATIONS_TOO_HIGH/.test(detail)) {
      return jsonError(
        "This account's password was stored with settings this platform " +
        "cannot verify. Reset it with staff_account.py reset-password.", 503);
    }
    if (/pbkdf2|derivebits|iterations/i.test(detail)) {
      return jsonError(
        "Password verification failed at the platform level. The iteration " +
        "count may exceed what Workers allows. Check the Worker logs.", 503);
    }
    if (/D1_ERROR|SQLITE/i.test(detail)) {
      return jsonError(
        "The database rejected the request. Check the Worker logs for details.", 503);
    }
    // Last resort. The real message goes to the Worker log, not the
    // browser -- this endpoint is public.
    //
    // Set DEBUG_ERRORS=1 in the Pages project to have the message
    // returned here as well, when tailing logs is impractical. It is
    // opt-in, off by default, and should be removed once diagnosed:
    // an exception message can disclose internals.
    if (env.DEBUG_ERRORS === "1") {
      return jsonError(`Login failed: ${detail}`, 500);
    }
    return jsonError("Login failed due to a server error. Check the Worker logs.", 500);
  }
}

// ============================================================
//  LOGIN
// ============================================================

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  interface LoginBody { username?: string; password?: string; }
  let body: LoginBody;
  try {
    body = await request.json() as LoginBody;
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const { username, password } = body;
  if (!username || typeof username !== "string") return jsonError("Username is required", 400);
  if (!password || typeof password !== "string") return jsonError("Password is required", 400);

  const safeUsername = username.trim().toLowerCase();

  const ip         = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua         = request.headers.get("User-Agent")        || "unknown";
  const ipHash     = await sha256(ip);
  const uaHash     = await sha256(ua);
  const now        = new Date();
  const nowIso     = now.toISOString();

  const maxAttempts   = parseInt(env.MAX_LOGIN_ATTEMPTS  || "5",  10);
  const lockoutMins   = parseInt(env.LOCKOUT_MINUTES     || "15", 10);
  const sessionHours  = parseInt(env.SESSION_DURATION_HOURS || "8", 10);

  // ── 1. Look up staff account ──────────────────────────────
  const account = await env.CORE_DB
    .prepare(`SELECT staff_id, username, password_hash, role,
                     failed_attempts, locked_until
              FROM   staff_accounts
              WHERE  username = ?`)
    .bind(safeUsername)
    .first() as {
      staff_id: string;
      username: string;
      password_hash: string;
      role: string;
      failed_attempts: number;
      locked_until: string | null;
    } | null;

    // ── 2. Resolve lock state (but don't act on it yet) ───────
  //    Previously this returned 429 "Account temporarily locked"
  //    immediately, before any password check. Six bad guesses
  //    against a REAL username produced that distinctive 429, while
  //    six against a nonexistent one kept returning 401 forever --
  //    a clean enumeration oracle, and a denial-of-service primitive
  //    against any named staff member (five bad guesses locks them
  //    out; repeat on a loop and they're locked out indefinitely).
  //
  //    The fix: compute whether the account is locked, but don't
  //    reveal it until AFTER the password has been verified below.
  //    Only someone who actually knows the password ever sees the
  //    lockout message -- that's not an oracle, it's just telling
  //    the legitimate owner why they can't log in.
  let isLocked = false;
  if (account?.locked_until) {
    const lockedUntil = new Date(account.locked_until);
    if (now < lockedUntil) {
      isLocked = true;
    } else {
      // Lock window expired — reset counters so this attempt is
      // evaluated fresh.
      await env.CORE_DB
        .prepare(`UPDATE staff_accounts
                  SET failed_attempts = 0, locked_until = NULL
                  WHERE staff_id = ?`)
        .bind(account.staff_id)
        .run();
      account.failed_attempts = 0;
      account.locked_until    = null;
    }
  }

  // ── 3. Password verification ──────────────────────────────
  //    Always run a verify (even for unknown accounts, even for
  //    locked ones) so response timing doesn't leak account state.
  //    The dummy MUST use the same iteration count as real hashes:
  //    a different count would both leak the difference through timing
  //    (defeating the point) and, above the platform cap, throw for
  //    every unknown username instead of returning a clean 401.
  const dummyHash =
    `0000000000000000:${PBKDF2_ITERATIONS}:` +
    "0000000000000000000000000000000000000000000000000000000000000000";
  const storedHash = account?.password_hash ?? dummyHash;
  const passwordOk = await verifyPassword(password, storedHash);

  if (!account || !passwordOk) {
    // Wrong password, unknown username, and a wrong password against
    // an already-locked account all return the exact same response.
    // Skip bumping the counter for an account that's already locked
    // -- it changes nothing and is just an extra write.
    if (account && !isLocked) {
      const newCount = (account.failed_attempts ?? 0) + 1;
      const lockUntil = newCount >= maxAttempts
        ? new Date(now.getTime() + lockoutMins * 60 * 1000).toISOString()
        : null;
      await env.CORE_DB
        .prepare(`UPDATE staff_accounts
                  SET failed_attempts = ?, locked_until = ?
                  WHERE staff_id = ?`)
        .bind(newCount, lockUntil, account.staff_id)
        .run();
    }
    return jsonError("Invalid username or password", 401);
  }

  // The password was correct. This branch is unreachable without
  // already knowing the credential, so revealing lock state here
  // discloses nothing to a guesser -- it's just telling the account
  // owner why they still can't get in.
  if (isLocked) {
    const lockedUntil = new Date(account.locked_until!);
    const retryAfterSecs = Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000);
    return new Response(
      JSON.stringify({ error: "Account temporarily locked. Too many failed attempts." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": retryAfterSecs.toString()
        }
      }
    );
  }

  // ── 4. Reset failure counter on success ───────────────────
  await env.CORE_DB
    .prepare(`UPDATE staff_accounts
              SET failed_attempts = 0, locked_until = NULL, last_login_at = ?
              WHERE staff_id = ?`)
    .bind(nowIso, account.staff_id)
    .run();

  // ── 5. Issue session token ────────────────────────────────
  const rawToken   = generateToken();          // random 32 bytes → hex
  const tokenHash  = await sha256(rawToken);   // stored; raw token never hits DB
  const sessionId  = crypto.randomUUID();
  const expiresAt  = new Date(now.getTime() + sessionHours * 3_600_000).toISOString();

  await env.CORE_DB
    .prepare(`INSERT INTO staff_sessions
                (session_id, staff_id, token_hash, ip_hash, ua_hash,
                 created_at, expires_at, invalidated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
    .bind(sessionId, account.staff_id, tokenHash, ipHash, uaHash, nowIso, expiresAt)
    .run();

  // ── 6. Log the login event ────────────────────────────────
  await logAccess(env.CORE_DB, {
    staffId:   account.staff_id,
    sessionId,
    action:    "login",
    ipHash,
    accessedAt: nowIso
  });

  return jsonResponse({
    token:      rawToken,     // only time the raw token is ever transmitted
    expires_at: expiresAt,
    username:   account.username,
    role:       account.role
  }, 200);
}

// ============================================================
//  LOGOUT
// ============================================================

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  const session = await resolveSession(request, env.CORE_DB);
  if (!session) return jsonError("Not authenticated", 401);

  const nowIso = new Date().toISOString();
  const ip     = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(ip);

  await env.CORE_DB
    .prepare(`UPDATE staff_sessions SET invalidated_at = ? WHERE session_id = ?`)
    .bind(nowIso, session.sessionId)
    .run();

  await logAccess(env.CORE_DB, {
    staffId:    session.staffId,
    sessionId:  session.sessionId,
    action:     "logout",
    ipHash,
    accessedAt: nowIso
  });

  return jsonResponse({ success: true, message: "Logged out successfully." });
}

// ============================================================
//  SESSION RESOLUTION  (shared by auth + data endpoints)
// ============================================================

export interface SessionContext {
  sessionId: string;
  staffId:   string;
  username:  string;
  role:      string;
}

/**
 * Extracts the Bearer token from the Authorization header,
 * hashes it, and looks it up in staff_sessions.
 *
 * Returns null if the token is missing, invalid, expired,
 * invalidated, or was issued to a different IP / User-Agent.
 */
export async function resolveSession(
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

  // Bind session to IP + User-Agent
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
//  ACCESS LOG HELPER
// ============================================================

async function logAccess(
  db: D1Database,
  opts: {
    staffId:     string;
    sessionId:   string;
    action:      string;
    ipHash:      string;
    accessedAt:  string;
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
//  CRYPTO HELPERS
// ============================================================

/** Generate a cryptographically random 32-byte token as a hex string. */
function generateToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
/**
 * Maximum PBKDF2 iterations Cloudflare Workers accepts. Exceeding it
 * throws at deploy time only -- local dev does not enforce it.
 */
const PBKDF2_ITERATIONS = 100_000;

/**
 * Hash a password with PBKDF2-SHA-256.
 * Stored format: "<hex(salt)>:<iterations>:<hex(hash)>"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt       = crypto.getRandomValues(new Uint8Array(16));
  // Cloudflare Workers caps PBKDF2 at 100,000 iterations in its WebCrypto
  // implementation and throws above it. Miniflare (wrangler pages dev) does
  // NOT enforce the cap, so 600,000 works locally and fails only once
  // deployed -- with a generic exception, since it is not a D1 error.
  //
  // OWASP recommends 600,000 for PBKDF2-SHA-256, so this is below current
  // guidance and that is a real trade-off. It is acceptable here because
  // staff_account.py generates 20-character passwords from a ~70-character
  // alphabet (~120 bits). Offline cracking of that is infeasible whatever
  // the KDF cost; iteration count matters most for human-chosen passwords.
  // If accounts ever use hand-picked passwords, revisit this.
  const iterations = PBKDF2_ITERATIONS;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256
  );
  return `${bytesToHex(salt)}:${iterations}:${bytesToHex(new Uint8Array(hashBuffer))}`;
}

/**
 * Verify a plaintext password against a stored PBKDF2 hash.
 * Uses a constant-time comparison to prevent timing attacks.
 */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [saltHex, iterStr, expectedHex] = parts;

  let salt: Uint8Array;
  try { salt = hexToBytes(saltHex); } catch { return false; }
  const iterations = parseInt(iterStr, 10);
  if (!iterations || iterations < 1) return false;

  // A hash stored with more iterations than the platform allows can never
  // be verified here. Surface it rather than letting deriveBits throw a
  // generic error that looks like a server fault.
  if (iterations > PBKDF2_ITERATIONS) {
    throw new Error(
      `STORED_HASH_ITERATIONS_TOO_HIGH: hash uses ${iterations} iterations, ` +
      `this platform allows at most ${PBKDF2_ITERATIONS}. Reset the password.`);
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256
  );
  const computedHex = bytesToHex(new Uint8Array(hashBuffer));

  // Constant-time string comparison (prevent timing oracle)
  return timingSafeEqual(computedHex, expectedHex);
}

/** Constant-time string comparison — always runs the full loop. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256(input: string): Promise<string> {
  const data   = new TextEncoder().encode(input);
  const buf    = await crypto.subtle.digest("SHA-256", data);
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

// ── Response helpers ──────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Never allow auth responses to be cached
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma":        "no-cache"
    }
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
