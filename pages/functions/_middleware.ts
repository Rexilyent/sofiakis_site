export async function onRequest(context: {
  request: Request;
  env: { CORE_DB?: any; APP_ENV?: string };
  next: () => Promise<Response>;
}) {
  const { request, env, next } = context;

  const url = new URL(request.url);

	// Canonical host enforcement
	//
	// Pages serves this project on *.pages.dev as well as the custom
	// domain. Zone-level proections (WAF rules, Access, Bot Fight Mode)
	// do not apply to *.pages.dev, so that hostname is a second, less
	// defended copy of the portal. Redirect it to the canonical origin
	// rather than serving from it.
	const PAGES_DEV_HOST = "sofiakissite.pages.dev"

	if (url.hostname === PAGES_DEV_HOST) {
		url.hostname = "alexandriasofiakis.com";
		url.protocol = "https:";
		return Response.redirect(url.toString(), 301);
	}

  // Only protect API routes
  if (!url.pathname.startsWith("/api/")) {
    return next();
  }

  // Skip rate limiting in development if desired
  if (env.APP_ENV === "development") {
    return next();
  }

  if (!env.CORE_DB) {
    return next(); // fail-open if DB not available
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // -- Per-route-class limits ------------------------------------
  //
  //  A single limit across all of /api/ was written for the public
  //  forms, where 5 submissions a minute from one IP is generous. The
  //  staff portal is a different shape entirely: opening it fires
  //  volunteers, calendar, articles and invitations, and every filter,
  //  page change and refresh is another request. Staff were hitting
  //  the limit before clicking anything.
  //
  //  Admin routes already require a valid session bound to an IP and
  //  user-agent, so authentication is the real gate; the limit here is
  //  a backstop against a runaway client, not an access control.
  //
  //  Buckets are keyed separately so portal traffic can never exhaust
  //  the allowance that protects the public forms.

  const path = url.pathname;

  // /api/admin-auth is the one route in the /api/admin- family that is
  // NOT authenticated by definition -- it's how a session is obtained
  // in the first place. It must be checked BEFORE the isAdmin prefix
  // match below, or it inherits the 120/minute portal allowance meant
  // for already-authenticated staff traffic. A credential-spraying
  // script would get 120 login attempts per IP per minute instead of
  // the 5 every other public route gets. Per-account lockout (see
  // admin-auth.ts) caps attempts against any ONE username, but does
  // nothing against spraying one password across many usernames --
  // this is the control that actually stops that.
  const isAdminAuth = path === "/api/admin-auth";
  const isAdmin      = !isAdminAuth && path.startsWith("/api/admin-");
  const isSignup     = path === "/api/staff-signup";

  let LIMIT: number;
  let bucket: string;

  if (isAdminAuth) {
    LIMIT  = 10;             // unauthenticated by definition; deliberately tight
    bucket = "admin-auth";
  } else if (isAdmin) {
    LIMIT = 120;            // authenticated staff; generous but bounded
    bucket = "admin";
  } else if (isSignup) {
    LIMIT = 20;             // unauthenticated, but token-gated per attempt
    bucket = "signup";
  } else {
    LIMIT = 5;              // public forms -- unchanged
    bucket = "public";
  }

  const key = await sha256(bucket + ":" + ip);
  const WINDOW_SECONDS = 60; // per 60 seconds

  /** Second, longer-window cap on top of the per-minute one for the
   * login endpoint specifically, so a slow spray -- a handful of
   * guesses a minute, staying under the 10/minute limit -- still gets
   * caught within the hour. */
  const ADMIN_AUTH_HOURLY_LIMIT = 50;
  const ADMIN_AUTH_HOURLY_WINDOW_SECONDS = 3600;

    // Everything below is wrapped: rate limiting is a safety net, not a
  // correctness requirement. A missing rate_limits table or a transient
  // D1 error previously threw here, which the runtime returned as a
  // plain-text 500 for EVERY api route -- taking down the whole portal
  // in order to enforce a limit. Failing open is the right trade.
  try {
    const blocked = await checkLimit(env, key, LIMIT, WINDOW_SECONDS);
    if (blocked) return blocked;

    if (isAdminAuth) {
      const hourlyKey = await sha256("admin-auth-hourly:" + ip);
      const hourlyBlocked = await checkLimit(
        env, hourlyKey, ADMIN_AUTH_HOURLY_LIMIT, ADMIN_AUTH_HOURLY_WINDOW_SECONDS
      );
      if (hourlyBlocked) return hourlyBlocked;
    }

    return next();
  } catch (err) {
    console.error("Rate limiter failed, allowing request:", err);
    return next();
  }
}

/**
 * Checks (and records) one request against one bucket/window.
 * Returns a 429 Response if the caller is over the limit, or null if
 * the request should proceed. Does NOT call next() itself -- unlike
 * the previous single-check version, callers may need to run more
 * than one independent check (e.g. a per-minute AND a per-hour cap)
 * before deciding whether to let the request through.
 */
async function checkLimit(
  env: { CORE_DB?: any },
  key: string,
  LIMIT: number,
  WINDOW_SECONDS: number
): Promise<Response | null> {
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;

  const existing = await env.CORE_DB.prepare(
    `SELECT count, window_start FROM rate_limits WHERE key = ?`
  )
    .bind(key)
    .first();

  if (!existing) {
    await env.CORE_DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start)
       VALUES (?, ?, ?)`
    )
      .bind(key, 1, new Date(now).toISOString())
      .run();

    return null;
  }

  const windowStart = new Date(existing.window_start).getTime();

  if (now - windowStart > windowMs) {
    await env.CORE_DB.prepare(
      `UPDATE rate_limits
       SET count = ?, window_start = ?
       WHERE key = ?`
    )
      .bind(1, new Date(now).toISOString(), key)
      .run();

    return null;
  }

  if (existing.count >= LIMIT) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please try again shortly." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": WINDOW_SECONDS.toString()
        }
      }
    );
  }

  await env.CORE_DB.prepare(
    `UPDATE rate_limits SET count = count + 1 WHERE key = ?`
  )
    .bind(key)
    .run();

  return null;
}

// ------------------
// SHA256 helper
// ------------------

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}