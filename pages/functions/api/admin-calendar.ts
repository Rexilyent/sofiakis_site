// ============================================================
//  ADMIN CALENDAR  —  /api/admin-calendar
// ============================================================
//
//  POST  /api/admin-calendar            — create a calendar event
//  GET   /api/admin-calendar?upcoming=1 — list the next 20 events
//  GET   /api/admin-calendar?from=<ISO>&to=<ISO>[&maxResults=N]
//                                       — list events in a date window
//
//        The windowed form backs the staff portal's month/week/day
//        calendar, which needs past events too. `upcoming=1` is kept
//        unchanged so the existing sidebar list keeps working.
//
//  All requests require:
//    Authorization: Bearer <session_token>
//
// ============================================================
//  REQUIRED ENVIRONMENT VARIABLES
// ============================================================
//
//  CORE_DB
//    Cloudflare D1 binding (for session validation).
//
//  GOOGLE_SERVICE_ACCOUNT_EMAIL
//    The email address of your Google service account.
//    e.g. campaign-calendar@your-project.iam.gserviceaccount.com
//
//  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//    The RSA private key from the service account JSON key file.
//    Copy the full "private_key" value including the
//    -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.
//    In the Cloudflare dashboard, paste the value with literal \n
//    characters OR use a multiline secret.
//
//  GOOGLE_CALENDAR_ID
//    The ID of the Google Calendar to use.
//    e.g. campaign@alexandriasofiakis.com  or  abc123@group.calendar.google.com
//    Find it in Google Calendar → Settings → [Calendar] → Calendar ID.
//
//  GOOGLE_CALENDAR_TIMEZONE  (optional, default: "America/Chicago")
//    IANA timezone for event creation.
//    IL-10 is in Central Time — override if needed.
//
// ============================================================
//  GOOGLE SETUP (one-time)
// ============================================================
//
//  1. Google Cloud Console → IAM & Admin → Service Accounts
//     → Create service account.
//  2. On the service account → Keys → Add Key → JSON.
//     Save the downloaded JSON — you need private_key and client_email.
//  3. Google Calendar → Settings → [Your Campaign Calendar]
//     → Share with specific people → add the service account email
//     with "Make changes to events" permission.
//  4. Add the three env vars to .dev.vars (dev) and
//     Cloudflare dashboard → Secrets (production).
//
// ============================================================

import { can, forbidden } from "../_lib/roles";

interface Env {
  CORE_DB?:                          D1Database;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?:     string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  GOOGLE_CALENDAR_ID?:               string;
  GOOGLE_CALENDAR_TIMEZONE?:         string;
  APP_ENV?:                          string;
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  return handleCreateEvent(context.request, context.env);
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}) {
  const url = new URL(context.request.url);
  if (url.searchParams.get("upcoming") === "1" || url.searchParams.get("from")) {
    return handleListEvents(context.request, context.env);
  }
  return jsonError("Invalid request", 400);
}

// ============================================================
//  CONFIGURATION CHECK
// ============================================================

/**
 * The list and create paths need the same three variables. They each
 * carried their own copy of this check, which had already drifted --
 * one told you to edit .dev.vars, the other environment variables --
 * so improving one left the other stale. That is exactly the copy the
 * portal was hitting.
 *
 * Returns a Response to send, or null when configuration is fine.
 */
function checkCalendarConfig(env: Env): Response | null {
  // Name the variables that are ACTUALLY missing. Listing all three
  // regardless is unhelpful when you believe you set them: the usual
  // cause is one typo, or a Pages deployment predating the variable.
  const missingVars = [
    ["GOOGLE_SERVICE_ACCOUNT_EMAIL",       env.GOOGLE_SERVICE_ACCOUNT_EMAIL],
    ["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY],
    ["GOOGLE_CALENDAR_ID",                 env.GOOGLE_CALENDAR_ID]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingVars.length) {
    console.warn("admin-calendar: missing env vars:", missingVars.join(", "));
    return jsonError(
      `Google Calendar is not configured \u2014 missing: ${missingVars.join(", ")}. ` +
      "If you have set these in Cloudflare, redeploy: Pages applies environment " +
      "variables only to deployments created after they were added.",
      503,
      { missing: missingVars }
    );
  }

  // A key that survived copy-paste but lost its newlines is the other
  // common failure, and it surfaces later as an opaque signing error.
  const pk = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!;
  if (!pk.includes("BEGIN") || !(pk.includes("\n") || pk.includes("\\n"))) {
    console.warn("admin-calendar: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY looks malformed");
    return jsonError(
      "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY does not look like a PEM key. It must " +
      "include the BEGIN/END lines and its newlines (literal, or escaped as \\n).",
      503,
      { missing: ["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"] }
    );
  }

  return null;
}

// ============================================================
//  HELPERS
// ============================================================

/**
 * Accept an ISO-8601 date or date-time and return a normalised
 * ISO string, or null if the value is missing/unparseable.
 * Rejecting bad input here keeps malformed values out of the
 * Google Calendar query string.
 */
function parseIsoParam(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ============================================================
//  CREATE EVENT
// ============================================================

async function handleCreateEvent(request: Request, env: Env): Promise<Response> {
  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  const session = await resolveSession(request, env.CORE_DB);
  if (!session)  return jsonError("Unauthorized", 401);

  if (!can(session.role, "calendar:write")) {
    return forbidden("calendar:write", session.role);
  }

  const configError = checkCalendarConfig(env);
  if (configError) return configError;

  interface EventBody {
    title?:       string;
    category?:    string;
    start?:       string;
    end?:         string;
    location?:    string;
    description?: string;
    attendees?:   string[];
    visibility?:  string;
  }

  let body: EventBody;
  try {
    body = await request.json() as EventBody;
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const { title, category, start, end, location, description, attendees, visibility } = body;

  const VALID_CATEGORIES = ["TOWN_HALL", "VOLUNTEER", "FUNDRAISER", "CANVASS"];

  if (!title?.trim())  return jsonError("Event title is required", 400);
  if (!start)          return jsonError("Start date/time is required", 400);
  if (!end)            return jsonError("End date/time is required", 400);

  // Validate that the title carries the correct bracket prefix
  // (the client assembles it, but we enforce it server-side too)
  const bracketMatch = (title || "").match(/^\[([^\]]+)\]\s*/);
  const embeddedCat  = bracketMatch ? bracketMatch[1].trim() : null;

  if (!embeddedCat || !VALID_CATEGORIES.includes(embeddedCat)) {
    return jsonError(
      `Title must start with a valid category prefix: [TOWN_HALL], [VOLUNTEER], [FUNDRAISER], or [CANVASS]. Got: "${embeddedCat || "none"}"`,
      400
    );
  }

  if (new Date(end) <= new Date(start)) {
    return jsonError("End date/time must be after start date/time", 400);
  }

  const tz = env.GOOGLE_CALENDAR_TIMEZONE || "America/Chicago";

  // ── Build the Google Calendar event resource ───────────────
  const eventResource: Record<string, unknown> = {
    summary:  title.trim(),
    start:    { dateTime: toIso(start), timeZone: tz },
    end:      { dateTime: toIso(end),   timeZone: tz },
    status:   "confirmed",
    visibility: ["public","private","default"].includes(visibility || "")
                  ? visibility
                  : "default"
  };

  if (location?.trim())    eventResource.location    = location.trim();
  if (description?.trim()) eventResource.description = description.trim();

  if (Array.isArray(attendees) && attendees.length > 0) {
    eventResource.attendees = attendees
      .filter(e => typeof e === "string" && e.includes("@"))
      .map(email => ({ email: email.trim() }));
  }

  // ── Get access token + call Calendar API ──────────────────
  let accessToken: string;
  try {
    accessToken = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      "https://www.googleapis.com/auth/calendar"
    );
  } catch (err) {
    console.error("Failed to get Google access token:", err);
    return jsonError("Failed to authenticate with Google Calendar. Check service account credentials.", 500);
  }

  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events?sendUpdates=all`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify(eventResource)
    }
  );

  const calData = await calRes.json() as Record<string, unknown>;

  if (!calRes.ok) {
    console.error("Google Calendar API error:", calData);
    const msg = (calData?.error as Record<string, unknown>)?.message as string
              || `Google Calendar returned ${calRes.status}`;
    return jsonError(msg, 502);
  }

  // ── Log access ────────────────────────────────────────────
  const ip     = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(ip);
  await logAccess(env.CORE_DB, {
    staffId:   session.staffId,
    sessionId: session.sessionId,
    action:    "create_calendar_event",
    ipHash,
    accessedAt: new Date().toISOString()
  });

  return secureJsonResponse({
    success:   true,
    event_id:  calData.id,
    html_link: calData.htmlLink
  }, 201);
}

// ============================================================
//  LIST UPCOMING EVENTS
// ============================================================

async function handleListEvents(request: Request, env: Env): Promise<Response> {
  if (!env.CORE_DB) return jsonError("Database not configured", 500);

  const session = await resolveSession(request, env.CORE_DB);
  if (!session)  return jsonError("Unauthorized", 401);

  if (!can(session.role, "calendar:read")) {
    return forbidden("calendar:read", session.role);
  }

  const configError = checkCalendarConfig(env);
  if (configError) return configError;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      "https://www.googleapis.com/auth/calendar.readonly"
    );
  } catch (err) {
    console.error("Failed to get Google access token:", err);
    return jsonError("Failed to authenticate with Google Calendar.", 500);
  }

  // ── Time window ───────────────────────────────────────────
  //  Default (upcoming=1): the next 20 events from now.
  //  Windowed (from/to):   an explicit range, used by the portal
  //  calendar so staff can page back through past months.
  const url      = new URL(request.url);
  const fromRaw  = url.searchParams.get("from");
  const toRaw    = url.searchParams.get("to");

  const timeMin  = parseIsoParam(fromRaw) || new Date().toISOString();

  // Clamp maxResults: Google caps at 2500, but a staff calendar
  // window never legitimately needs more than a few hundred.
  let maxResults = 20;
  const maxRaw   = url.searchParams.get("maxResults");
  if (maxRaw) {
    const n = parseInt(maxRaw, 10);
    if (!isNaN(n)) maxResults = Math.min(Math.max(n, 1), 250);
  } else if (fromRaw) {
    maxResults = 250;
  }

  const params   = new URLSearchParams({
    timeMin,
    maxResults:   String(maxResults),
    singleEvents: "true",
    orderBy:      "startTime"
  });

  const timeMax = parseIsoParam(toRaw);
  if (timeMax) params.set("timeMax", timeMax);

  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events?${params}`,
    {
      headers: { "Authorization": `Bearer ${accessToken}` }
    }
  );

  const calData = await calRes.json() as {
    items?: Array<{
      id:       string;
      summary?: string;
      start?:   { dateTime?: string; date?: string };
      end?:     { dateTime?: string; date?: string };
      location?:    string;
      htmlLink?:    string;
      description?: string;
      status?:      string;
    }>;
  };

  if (!calRes.ok) {
    return jsonError("Failed to fetch events from Google Calendar.", 502);
  }

  const events = (calData.items || [])
    .filter(ev => ev.status !== "cancelled")
    .map(ev => ({
      id:          ev.id,
      title:       ev.summary     || "(Untitled)",
      start:       ev.start?.dateTime || ev.start?.date || null,
      end:         ev.end?.dateTime   || ev.end?.date   || null,
      all_day:     !ev.start?.dateTime,
      location:    ev.location    || null,
      description: ev.description || null,
      html_link:   ev.htmlLink    || null
    }));

  return secureJsonResponse({ events });
}

// ============================================================
//  GOOGLE SERVICE ACCOUNT JWT + TOKEN
// ============================================================

/**
 * Generate a short-lived OAuth 2.0 access token for a Google
 * service account using the JWT Bearer flow (RFC 7523).
 *
 * No refresh tokens are stored — each request mints a fresh
 * token valid for 1 hour, which is the maximum Google allows.
 */
async function getAccessToken(
  serviceAccountEmail: string,
  privateKeyPem: string,
  scope: string
): Promise<string> {

  const now       = Math.floor(Date.now() / 1000);
  const expiry    = now + 3600;

  // ── 1. Build the JWT header + payload ────────────────────
  const header  = btoa64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa64(JSON.stringify({
    iss:   serviceAccountEmail,
    scope,
    aud:   "https://oauth2.googleapis.com/token",
    exp:   expiry,
    iat:   now
  }));

  const signingInput = `${header}.${payload}`;

  // ── 2. Import the PEM private key ────────────────────────
  // Strip PEM headers and whitespace, decode base64 → DER
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "\n")    // handle literal \n from env var
    .replace(/\s+/g, "");

  const derBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    derBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // ── 3. Sign JWT ───────────────────────────────────────────
  const encoder   = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(signingInput)
  );

  const jwt = `${signingInput}.${btoa64(signature)}`;

  // ── 4. Exchange JWT for access token ─────────────────────
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt
    })
  });

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

  if (!tokenData.access_token) {
    throw new Error(tokenData.error || "No access token returned from Google");
  }

  return tokenData.access_token;
}

/** URL-safe base64 encode — works with strings and ArrayBuffers. */
function btoa64(input: string | ArrayBuffer): string {
  let str: string;
  if (typeof input === "string") {
    str = input;
  } else {
    str = String.fromCharCode(...new Uint8Array(input));
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse a datetime-local value (YYYY-MM-DDTHH:mm) into a full ISO string. */
function toIso(value: string): string {
  // datetime-local gives "2026-07-04T14:00" — add seconds for Google
  return value.includes(":") && value.split(":").length === 2
    ? value + ":00"
    : value;
}

// ============================================================
//  SESSION RESOLUTION  (same pattern as admin-auth.ts)
// ============================================================

interface SessionContext {
  sessionId: string;
  staffId:   string;
  username:  string;
  role:      string;
}

async function resolveSession(request: Request, db: D1Database): Promise<SessionContext | null> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const rawToken  = authHeader.slice(7).trim();
  if (!rawToken)  return null;

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
    .first() as { session_id: string; staff_id: string; ip_hash: string; ua_hash: string; username: string; role: string; } | null;

  if (!row) return null;

  const ip     = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua     = request.headers.get("User-Agent")        || "unknown";
  const ipHash = await sha256(ip);
  const uaHash = await sha256(ua);

  if (ipHash !== row.ip_hash || uaHash !== row.ua_hash) return null;

  return { sessionId: row.session_id, staffId: row.staff_id, username: row.username, role: row.role };
}

// ============================================================
//  HELPERS
// ============================================================

async function logAccess(db: D1Database, opts: {
  staffId: string; sessionId: string; action: string;
  ipHash: string; accessedAt: string;
}): Promise<void> {
  await db
    .prepare(`INSERT INTO staff_access_log
                (log_id, staff_id, session_id, action, ip_hash, accessed_at, record_count)
              VALUES (?, ?, ?, ?, ?, ?, NULL)`)
    .bind(crypto.randomUUID(), opts.staffId, opts.sessionId, opts.action, opts.ipHash, opts.accessedAt)
    .run();
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function secureJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma":        "no-cache"
    }
  });
}

function jsonError(
  message: string,
  status = 400,
  extra?: Record<string, unknown>
): Response {
  return secureJsonResponse({ error: message, ...(extra || {}) }, status);
}