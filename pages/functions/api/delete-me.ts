export async function onRequestPost(context: {
  request: Request;
  env: {
    MONEY_DB: D1Database;
    TURNSTILE_SECRET_KEY?: string;
    ALLOW_HARD_DELETE?: string;
    ADMIN_DELETE_KEY?: string;
  };
}) {
  const { request, env } = context;

  try {
    if (!env.TURNSTILE_SECRET_KEY) {
      return jsonError("Server configuration error", 500);
    }

    const body = await request.json();
    const { email, turnstileToken, mode = "soft", adminKey } = body;

    if (!email) return jsonError("Email is required", 400);
    if (!turnstileToken) return jsonError("Missing Turnstile token", 400);

    // ==============================
    // Turnstile Verification
    // ==============================

    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
        }),
      }
    );

    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return jsonError("Turnstile verification failed", 403);
    }

    // ==============================
    // Find Volunteer
    // ==============================

    const volunteer = await env.MONEY_DB.prepare(`
      SELECT volunteer_id FROM volunteers
      WHERE email = ?
    `)
      .bind(email.toLowerCase())
      .first();

    if (!volunteer) {
      return jsonError("No record found", 404);
    }

    const volunteerId = volunteer.volunteer_id;

    // ==============================
    // HARD DELETE (Admin Only)
    // ==============================

    if (mode === "hard") {
      if (env.ALLOW_HARD_DELETE !== "true") {
        return jsonError("Hard delete not enabled", 403);
      }

      if (!adminKey || adminKey !== env.ADMIN_DELETE_KEY) {
        return jsonError("Unauthorized hard delete attempt", 403);
      }

      await env.MONEY_DB.prepare(`
				DELETE FROM volunteers WHERE volunteer_id = ?
      `)
      .bind(volunteerId)
      .run();

      await logDeletion(env, volunteerId, email, "hard");

      return jsonResponse({
        success: true,
        message: "Record permanently deleted."
      });
    }

    // ==============================
    // SOFT DELETE (Default)
    // ==============================

    await env.MONEY_DB.prepare(`
      UPDATE volunteers
      SET deleted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE volunteer_id = ?
    `)
      .bind(volunteerId)
      .run();

    await logDeletion(env, volunteerId, email, "soft");

    return jsonResponse({
      success: true,
      message: "Your data has been removed."
    });

  } catch (err) {
    return jsonError("Unexpected server error", 500);
  }
}

async function logDeletion(
  env: any,
  volunteerId: string,
  email: string,
  type: "soft" | "hard"
) {
  await env.MONEY_DB.prepare(`
    INSERT INTO deletion_requests
    (request_id, volunteer_id, email, type, requested_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `)
    .bind(
      crypto.randomUUID(),
      volunteerId,
      email.toLowerCase(),
      type
    )
    .run();
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number) {
  return jsonResponse({ error: message }, status);
}