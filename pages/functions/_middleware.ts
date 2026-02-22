export async function onRequest(context: {
  request: Request;
  env: { DB?: any; APP_ENV?: string };
  next: () => Promise<Response>;
}) {
  const { request, env, next } = context;

  const url = new URL(request.url);

  // Only protect API routes
  if (!url.pathname.startsWith("/api/")) {
    return next();
  }

  // Skip rate limiting in development if desired
  if (env.APP_ENV === "development") {
    return next();
  }

  if (!env.DB) {
    return next(); // fail-open if DB not available
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256(ip);

  const LIMIT = 5;          // max requests
  const WINDOW_SECONDS = 60; // per 60 seconds

  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;

  const existing = await env.DB.prepare(
    `SELECT count, window_start FROM rate_limits WHERE key = ?`
  )
    .bind(key)
    .first();

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start)
       VALUES (?, ?, ?)`
    )
      .bind(key, 1, new Date(now).toISOString())
      .run();

    return next();
  }

  const windowStart = new Date(existing.window_start).getTime();

  if (now - windowStart > windowMs) {
    await env.DB.prepare(
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

  await env.DB.prepare(
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