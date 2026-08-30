// ============================================================
//  POST /api/delete-me
// ============================================================
//
//  Self-service data deletion, verified by email.
//
//  REQUIRED ENVIRONMENT VARIABLES (Cloudflare Worker Secrets)
//
//  TURNSTILE_SECURITY_KEY  — Cloudflare Turnstile secret key
//  FIELD_HMAC_KEY          — 32-byte hex string (64 hex chars). Same key
//                            volunteer.ts uses for email_hash. Also used
//                            here to hash the link token and the code.
//  RESEND_API_KEY          — Resend email API key
//  PUBLIC_ORIGIN           — Optional. Canonical site origin used to build
//                            the confirmation link, e.g.
//                            "https://alexandriasofiakis.com". Falls back to
//                            the request origin when unset.
//  APP_ENV                 — "development" enables verbose error messages
//
// ============================================================
//  WHY THIS IS A TWO-STEP FLOW
// ============================================================
//
//  The previous version deleted a record on a single POST containing
//  nothing but an email address and a Turnstile token. Turnstile proves
//  a human is present; it does not prove the human owns the mailbox.
//  Anyone who knew (or guessed) a supporter's email could erase them,
//  and the 404 on a miss doubled as an address-enumeration oracle.
//
//  The flow now has two stages, and BOTH require the mailbox:
//
//    1. "request"  — POST { action: "request", email, turnstileToken }
//                    Always answers with the same generic message. If the
//                    address matches a live record we mint a one-time
//                    token plus a short human-readable code, and email
//                    both to that address. If it does not match, nothing
//                    is sent and nothing is stored.
//
//    2. "confirm"  — POST { action: "confirm", token, email, code,
//                           turnstileToken }
//                    The token arrives in the URL of the emailed link.
//                    The code is printed in the body of that same email.
//                    The requester re-types their address and the code.
//                    Only when all three agree is the record removed.
//
//  ── WHY A CODE AS WELL AS A LINK ───────────────────────────
//
//  A link on its own is not enough, because clicking it cannot be the
//  thing that deletes the record. Corporate mail filters, link scanners
//  and antivirus proxies routinely fetch every URL in an incoming
//  message. A GET that mutates data would fire the moment the message
//  landed, before the recipient ever saw it. So there is deliberately no
//  GET handler here at all: the emailed link points at the static
//  /delete-me page, and deletion only happens on a POST that carries a
//  code no automated fetcher can read out of the URL.
//
//  The code also limits the blast radius of a leaked link — shoulder
//  surfing, a shared screen, a Referer header, browser history — since
//  the URL alone does nothing without the code beside it.
//
//  ── WHAT IS STORED ─────────────────────────────────────────
//
//  Neither the token nor the code is written to the database in the
//  clear; both are stored as keyed HMACs. Read access to D1 therefore
//  does not hand anybody a working deletion link. The code's HMAC is
//  salted with its own token so two outstanding requests can never
//  cross-validate each other.
//
// ============================================================
//  NOTE ON WHAT "DELETE" MEANS HERE
// ============================================================
//
//  This endpoint still performs a SOFT delete: it stamps deleted_at and
//  leaves the encrypted PII columns in place. That is unchanged from the
//  previous version and is deliberate — changing the retention semantics
//  is a separate decision from fixing the authentication, and the portal
//  and export paths have their own soft-delete filtering work outstanding.
//
//  Worth deciding on soon: a supporter who asks to be deleted is unlikely
//  to read "we kept your name, email, phone and ZIP, just flagged" as
//  honouring the request. Scrubbing the ciphertext while retaining
//  email_hash would satisfy the request and still let the campaign
//  suppress re-adds. See scrubVolunteerPii() at the foot of this file,
//  which is written and tested but not called.
//
// ============================================================

interface DeleteEnv {
  CORE_DB?: any;
  TURNSTILE_SECURITY_KEY?: string;
  FIELD_HMAC_KEY?: string;
  RESEND_API_KEY?: string;
  PUBLIC_ORIGIN?: string;
  APP_ENV?: string;
}

// ---- Tunables ------------------------------------------------

/** How long a verification code stays usable. */
const CODE_TTL_MINUTES = 30;

/** Wrong-code guesses allowed against one token before it dies. */
const MAX_CODE_ATTEMPTS = 5;

/** Minimum gap between emails to the same address. */
const RESEND_COOLDOWN_SECONDS = 60;

/** Ceiling on emails to one address per hour, cooldown or not. */
const MAX_REQUESTS_PER_HOUR = 5;

/**
 * Alphabet for the human-typed code. Excludes I, L, O, 0 and 1 so a code
 * read off a phone screen and typed into a laptop does not fail on a
 * character nobody can distinguish. 31 symbols over 8 positions is
 * roughly 8.5e11 combinations, against 5 guesses in 30 minutes.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/**
 * Every failure in the confirm step returns this one string. Which of the
 * token, the address or the code was wrong is not the requester's
 * business, and telling them turns the endpoint into an oracle.
 */
const GENERIC_CONFIRM_FAILURE =
  "That link or code is not valid, has expired, or has already been used. " +
  "Please start again.";

/**
 * Likewise, the request step cannot reveal whether an address is on file.
 * Both outcomes return this.
 */
const GENERIC_REQUEST_ACCEPTED =
  "If that address is in our records, we've sent a confirmation email " +
  "with a link and a code. Please check your inbox.";

// ============================================================
//  ROUTE
// ============================================================

export async function onRequestPost(context: {
  request: Request;
  env: DeleteEnv;
}) {
  const { request, env } = context;
  const isDev = env.APP_ENV === "development";

  try {
    // ----------------------------------------
    // Guard: required configuration
    // ----------------------------------------
    if (!env.CORE_DB) {
      return jsonError("Server configuration error: CORE_DB is not bound", 500);
    }
    if (!env.TURNSTILE_SECURITY_KEY) {
      return jsonError("Server configuration error: missing Turnstile key", 500);
    }
    // Required in every environment. volunteer.ts hashes email_hash with
    // this key unconditionally, so a missing key here does not degrade
    // gracefully — it means no record can ever be located.
    if (!env.FIELD_HMAC_KEY) {
      return jsonError("Server configuration error: FIELD_HMAC_KEY is not set", 500);
    }

    // ----------------------------------------
    // Parse + shape the body
    // ----------------------------------------
    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
      return jsonError("Content-Type must be application/json", 415);
    }

    interface DeleteBody {
      action?: string;
      email?: string;
      code?: string;
      token?: string;
      turnstileToken?: string;
    }

    let body: DeleteBody;
    try {
      body = await request.json() as DeleteBody;
    } catch {
      return jsonError("Malformed JSON body", 400);
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (action !== "request" && action !== "confirm") {
      return jsonError('action must be "request" or "confirm"', 400);
    }

    // ----------------------------------------
    // Turnstile — required for both stages
    // ----------------------------------------
    // The confirm stage is challenged as well as the request stage.
    // Without it, the five code attempts could be spent by a script the
    // instant the email lands, and the IP rate limit is the only thing
    // standing between a distributed guesser and a valid code.
    if (typeof body.turnstileToken !== "string" || !body.turnstileToken) {
      return jsonError("Missing Turnstile token", 400);
    }

    const turnstileOk = await verifyTurnstile(
      body.turnstileToken,
      env.TURNSTILE_SECURITY_KEY,
      request.headers.get("CF-Connecting-IP")
    );
    if (!turnstileOk) {
      return jsonError("Turnstile verification failed", 403);
    }

    return action === "request"
      ? await handleRequestStage(request, env, body)
      : await handleConfirmStage(request, env, body);

  } catch (err) {
    console.error("delete-me error:", err);
    const message = isDev && err instanceof Error
      ? err.message
      : "An unexpected error occurred. Please try again.";
    return jsonError(message, 500);
  }
}

// ============================================================
//  STAGE 1 — REQUEST
// ============================================================
//
//  Take an email address, and if it belongs to a live record, mail that
//  address a one-time link and code. Answer identically either way.

async function handleRequestStage(
  request: Request,
  env: DeleteEnv,
  body: { email?: string }
): Promise<Response> {
  const email = typeof body.email === "string" ? body.email.trim() : "";

  // Shape validation only. An address that fails these checks cannot
  // match a stored record anyway, so rejecting it leaks nothing.
  if (!email) return jsonError("Email is required", 400);
  if (email.length > 254) return jsonError("Email must be 254 characters or fewer", 400);

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) return jsonError("Invalid email address", 400);

  const normalizedEmail = email.toLowerCase();
  const emailHash = await hmacSha256(normalizedEmail, env.FIELD_HMAC_KEY!);

  // Everything from here down answers GENERIC_REQUEST_ACCEPTED regardless
  // of outcome. Returns are early only to skip pointless work.
  const accepted = () => jsonResponse({ success: true, message: GENERIC_REQUEST_ACCEPTED });

  const volunteer = await env.CORE_DB
    .prepare(
      `SELECT volunteer_id FROM volunteers
       WHERE email_hash = ? AND deleted_at IS NULL`
    )
    .bind(emailHash)
    .first();

  if (!volunteer) return accepted();

  const volunteerId = volunteer.volunteer_id as string;

  // ----------------------------------------
  // Per-address throttle
  // ----------------------------------------
  // The IP limit in _middleware.ts protects the endpoint. This protects
  // the mailbox: without it, anyone can point the form at a supporter's
  // address and flood their inbox with deletion codes.
  const nowMs = Date.now();
  const hourAgo = new Date(nowMs - 3600 * 1000).toISOString();

  const recent = await env.CORE_DB
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS latest
       FROM deletion_verifications
       WHERE email_hash = ? AND created_at > ?`
    )
    .bind(emailHash, hourAgo)
    .first();

  const sentThisHour = Number(recent?.n ?? 0);
  if (sentThisHour >= MAX_REQUESTS_PER_HOUR) {
    console.warn("delete-me: hourly cap reached for one address; email suppressed");
    return accepted();
  }

  if (recent?.latest) {
    const sinceLast = nowMs - new Date(recent.latest as string).getTime();
    if (sinceLast < RESEND_COOLDOWN_SECONDS * 1000) {
      return accepted();
    }
  }

  // ----------------------------------------
  // Mint the token and the code
  // ----------------------------------------
  const token = randomToken();          // goes in the link
  const code = randomCode();            // printed in the email body
  const tokenHash = await hmacSha256(`delete-token:${token}`, env.FIELD_HMAC_KEY!);
  const codeHash = await hmacSha256(
    `delete-code:${token}:${code}`,      // salted with its own token
    env.FIELD_HMAC_KEY!
  );

  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "");

  // One live code per address. Retiring the previous outstanding request
  // means a code someone read over a supporter's shoulder yesterday stops
  // working the moment a fresh one is issued.
  await env.CORE_DB
    .prepare(
      `UPDATE deletion_verifications
       SET consumed_at = ?
       WHERE email_hash = ? AND consumed_at IS NULL`
    )
    .bind(now, emailHash)
    .run();

  await env.CORE_DB
    .prepare(
      `INSERT INTO deletion_verifications (
         verification_id, token_hash, code_hash, email_hash,
         volunteer_id, attempts, created_at, expires_at, ip_hash
       )
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      tokenHash,
      codeHash,
      emailHash,
      volunteerId,
      now,
      expiresAt,
      ipHash
    )
    .run();

  // ----------------------------------------
  // Send it
  // ----------------------------------------
  // PUBLIC_ORIGIN is preferred over the request origin so the link can
  // never be built from an attacker-supplied Host header.
  const origin = env.PUBLIC_ORIGIN || new URL(request.url).origin;
  const link = `${origin}/delete-me?token=${encodeURIComponent(token)}`;

  await sendVerificationEmail(env, normalizedEmail, link, code);

  return accepted();
}

// ============================================================
//  STAGE 2 — CONFIRM
// ============================================================
//
//  Token from the link, address and code re-typed by the requester.
//  All three must agree, and any disagreement gives the same answer.

async function handleConfirmStage(
  request: Request,
  env: DeleteEnv,
  body: { token?: string; email?: string; code?: string }
): Promise<Response> {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const rawCode = typeof body.code === "string" ? body.code : "";

  if (!token || !email || !rawCode) {
    return jsonError("Link, email address and code are all required", 400);
  }

  // Bound the inputs before they reach the HMACs. Nothing legitimate is
  // anywhere near these lengths.
  if (token.length > 128 || email.length > 254 || rawCode.length > 32) {
    return jsonError(GENERIC_CONFIRM_FAILURE, 400);
  }

  // People paste codes with the hyphen we print, in whatever case their
  // keyboard was in. Normalise to what we generated.
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) {
    return jsonError(GENERIC_CONFIRM_FAILURE, 400);
  }

  const failure = () => jsonError(GENERIC_CONFIRM_FAILURE, 400);

  const tokenHash = await hmacSha256(`delete-token:${token}`, env.FIELD_HMAC_KEY!);

  const row = await env.CORE_DB
    .prepare(
      `SELECT verification_id, code_hash, email_hash, volunteer_id,
              attempts, expires_at, consumed_at
       FROM deletion_verifications
       WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first();

  if (!row) return failure();
  if (row.consumed_at) return failure();
  if (new Date(row.expires_at as string).getTime() < Date.now()) return failure();
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) return failure();

  // Charge the attempt BEFORE checking anything. If the comparison below
  // throws, or the isolate is torn down mid-request, the guess must still
  // have cost something — otherwise the attempt counter is free to reset
  // by crashing the worker.
  await env.CORE_DB
    .prepare(
      `UPDATE deletion_verifications
       SET attempts = attempts + 1
       WHERE verification_id = ?`
    )
    .bind(row.verification_id)
    .run();

  // ----------------------------------------
  // Compare address and code
  // ----------------------------------------
  const emailHash = await hmacSha256(email.toLowerCase(), env.FIELD_HMAC_KEY!);
  const codeHash = await hmacSha256(
    `delete-code:${token}:${code}`,
    env.FIELD_HMAC_KEY!
  );

  // Both comparisons run before either is acted on, so response time does
  // not reveal which one failed.
  const emailOk = timingSafeEqual(emailHash, row.email_hash as string);
  const codeOk = timingSafeEqual(codeHash, row.code_hash as string);

  if (!emailOk || !codeOk) return failure();

  // ----------------------------------------
  // Consume the token, then delete
  // ----------------------------------------
  // The guard in the WHERE clause is the whole point: two requests that
  // both passed the consumed_at check above race to this UPDATE, and D1
  // reports changes === 1 to exactly one of them. Checking the row and
  // then trusting the check would let both proceed.
  const consumedAt = new Date().toISOString();
  const claim = await env.CORE_DB
    .prepare(
      `UPDATE deletion_verifications
       SET consumed_at = ?
       WHERE verification_id = ? AND consumed_at IS NULL`
    )
    .bind(consumedAt, row.verification_id)
    .run();

  if (!claim?.meta || claim.meta.changes !== 1) return failure();

  const volunteerId = row.volunteer_id as string;

  await env.CORE_DB
    .prepare(
      `UPDATE volunteers
       SET deleted_at = ?, updated_at = ?
       WHERE volunteer_id = ? AND deleted_at IS NULL`
    )
    .bind(consumedAt, consumedAt, volunteerId)
    .run();

  // Retire any other outstanding codes for this address — the record is
  // gone, so they have nothing left to authorise.
  await env.CORE_DB
    .prepare(
      `UPDATE deletion_verifications
       SET consumed_at = ?
       WHERE email_hash = ? AND consumed_at IS NULL`
    )
    .bind(consumedAt, row.email_hash)
    .run();

  await logDeletion(env, volunteerId, row.email_hash as string, "soft");

  return jsonResponse({
    success: true,
    message: "Your information has been removed from our records."
  });
}

// ============================================================
//  DELETION LOG
// ============================================================

async function logDeletion(
  env: DeleteEnv,
  volunteerId: string,
  emailDigest: string,
  type: "soft" | "hard"
) {
  await env.CORE_DB.prepare(
    `INSERT INTO deletion_requests
       (request_id, volunteer_id, email, type, requested_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      volunteerId,
      emailDigest, // the HMAC digest — never the plaintext address
      type,
      new Date().toISOString()
    )
    .run();
}

// ============================================================
//  TURNSTILE
// ============================================================

async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | null
): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form
      }
    );
    const data = await res.json() as { success?: boolean };
    return data.success === true;
  } catch (err) {
    // Fail closed. A Turnstile outage should stop deletions, not wave
    // them through — this is the only bot gate on an unauthenticated,
    // destructive endpoint.
    console.error("Turnstile verification error:", err);
    return false;
  }
}

// ============================================================
//  EMAIL
// ============================================================

/**
 * The message carries both halves of the credential: the link (token) and
 * the code. Nothing the requester typed is interpolated into the HTML —
 * the only variables are our own token and our own alphabet — so there is
 * no path for injected markup here.
 */
async function sendVerificationEmail(
  env: DeleteEnv,
  to: string,
  link: string,
  code: string
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY not configured. Deletion email not sent.");
    return;
  }

  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;

  const html = `
    <p>We received a request to delete your information from the
       Alexandria Sofiakis for IL-10 campaign records.</p>

    <p>To confirm, open the link below and enter this code:</p>

    <p style="font-size:24px;font-weight:700;letter-spacing:3px;
              font-family:monospace;">${pretty}</p>

    <p><a href="${link}">Confirm deletion request</a></p>

    <p>You will be asked to re-enter your email address along with the
       code above. This link and code expire in ${CODE_TTL_MINUTES} minutes
       and can only be used once.</p>

    <p><strong>If you did not request this, you can ignore this email.</strong>
       Nothing will be deleted unless the code above is entered, and the code
       is only in this message.</p>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "no-reply@alexandriasofiakis.com",
        to,
        subject: "Confirm your data deletion request",
        html
      })
    });

    if (!res.ok) {
      // Logged, but the caller still returns the generic acceptance —
      // surfacing a send failure would confirm the address exists.
      console.error("Resend rejected deletion email:", res.status);
    }
  } catch (err) {
    console.error("Deletion email send failed:", err);
  }
}

// ============================================================
//  TOKEN + CODE GENERATION
// ============================================================

/** 256 bits of entropy, base64url, for the link. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The human-typed code.
 *
 * Rejection sampling rather than `byte % 31`: 256 is not a multiple of 31,
 * so the modulo would make the first eleven symbols of the alphabet
 * measurably more likely than the rest. It costs one extra byte now and
 * again and removes the bias entirely.
 */
function randomCode(): string {
  const n = CODE_ALPHABET.length;
  const limit = Math.floor(256 / n) * n;   // 248 for a 31-symbol alphabet
  let out = "";

  while (out.length < CODE_LENGTH) {
    const batch = crypto.getRandomValues(
      new Uint8Array(new ArrayBuffer(CODE_LENGTH))
    );
    for (const b of batch) {
      if (b >= limit) continue;            // discard, do not fold
      out += CODE_ALPHABET[b % n];
      if (out.length === CODE_LENGTH) break;
    }
  }

  return out;
}

// ============================================================
//  CRYPTO HELPERS
// ============================================================

/**
 * HMAC-SHA256 keyed digest.
 * Deterministic — the same input always produces the same digest —
 * but not reversible to the original value without the key.
 */
async function hmacSha256(value: string, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = new TextEncoder().encode(value);
  const sig = await crypto.subtle.sign("HMAC", key, data);

  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Plain SHA-256, used for IP fingerprinting. */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Length-independent, content-constant-time string comparison.
 *
 * `a === b` on a hex digest short-circuits at the first differing
 * character, so the time it takes to fail is a readout of how many
 * leading characters were right. Against a code with only five guesses
 * that is not much of a lever, but this is the comparison that gates an
 * irreversible action and there is no reason to hand out the signal.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============================================================
//  OPTIONAL: PII SCRUB
// ============================================================
//
//  Not wired up. See the note in the file header.
//
//  Overwrites the encrypted PII columns with per-record tombstones while
//  keeping volunteer_id and email_hash, so the campaign can still honour
//  the opt-out if the same address signs up again. The tombstones are
//  unique per record because volunteers.email carries a UNIQUE index — a
//  shared constant would collide on the second deletion.
//
//  Note that admin-volunteers.ts decrypts through a helper that returns
//  "[decryption error]" rather than throwing, so scrubbed rows would show
//  that string in the portal until the soft-delete filtering lands.

export async function scrubVolunteerPii(
  env: DeleteEnv,
  volunteerId: string
): Promise<void> {
  const tombstone = `deleted:${volunteerId}`;

  await env.CORE_DB
    .prepare(
      `UPDATE volunteers
       SET name = ?, email = ?, phone = NULL, zip = ?
       WHERE volunteer_id = ?`
    )
    .bind(tombstone, tombstone, "00000", volunteerId)
    .run();
}

// ============================================================
//  RESPONSE HELPERS
// ============================================================

/**
 * Pages Functions responses are not covered by the _headers file, so the
 * headers that matter for this route are set here. no-store in particular:
 * an intermediary caching a deletion response would be its own problem.
 */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function jsonError(message: string, status: number) {
  return jsonResponse({ error: message }, status);
}
