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
  const isAdmin  = path.startsWith("/api/admin-");
  const isSignup = path === "/api/staff-signup";

  let LIMIT: number;
  let bucket: string;

  if (isAdmin) {
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

  // Everything below is wrapped: rate limiting is a safety net, not a
  // correctness requirement. A missing rate_limits table or a transient
  // D1 error previously threw here, which the runtime returned as a
  // plain-text 500 for EVERY api route -- taking down the whole portal
  // in order to enforce a limit. Failing open is the right trade.
  try {
    return await enforceLimit(env, key, LIMIT, WINDOW_SECONDS, next);
  } catch (err) {
    console.error("Rate limiter failed, allowing request:", err);
    return next();
  }
}

async function enforceLimit(
  env: { CORE_DB?: any },
  key: string,
  LIMIT: number,
  WINDOW_SECONDS: number,
  next: () => Promise<Response>
): Promise<Response> {
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

    return next();
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

    return next();
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

  return next();
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