export async function onRequestPost(context: {
  request: Request;
  env: {
    CORE_DB: D1Database;
    TURNSTILE_SECURITY_KEY?: string;
    ALLOW_HARD_DELETE?: string;
    ADMIN_DELETE_KEY?: string;
    FIELD_HMAC_KEY?: string;
  };
}) {
  const { request, env } = context;

  try {
    if (!env.TURNSTILE_SECURITY_KEY) {
      return jsonError("Server configuration error: missing Turnstile key", 500);
    }

    if (!env.FIELD_HMAC_KEY) {
      return jsonError("Server configuration error: missing HMAC key", 500);
    }

    interface DeleteBody {
      email?: string;
      turnstileToken?: string;
      mode?: string;
      adminKey?: string;
    }

    const body = await request.json() as DeleteBody;
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
          secret: env.TURNSTILE_SECURITY_KEY,
          response: turnstileToken,
        }),
      }
    );

    const verifyData = await verifyRes.json() as { success: boolean };
    if (!verifyData.success) {
      return jsonError("Turnstile verification failed", 403);
    }

    // ==============================
    // Find Volunteer via email_hash
    // ==============================

    const emailDigest = await hmacSha256(email.trim().toLowerCase(), env.FIELD_HMAC_KEY);

    const volunteer = await env.CORE_DB.prepare(`
      SELECT volunteer_id FROM volunteers
      WHERE email_hash = ?
    `)
      .bind(emailDigest)
      .first();

    if (!volunteer) {
      return jsonError("No record found", 404);
    }

    const volunteerId = volunteer.volunteer_id as string;

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

      await env.CORE_DB.prepare(`
        DELETE FROM volunteers WHERE volunteer_id = ?
      `)
      .bind(volunteerId)
      .run();

      await logDeletion(env, volunteerId, emailDigest, "hard");

      return jsonResponse({
        success: true,
        message: "Record permanently deleted."
      });
    }

    // ==============================
    // SOFT DELETE (Default)
    // ==============================

    await env.CORE_DB.prepare(`
      UPDATE volunteers
      SET deleted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE volunteer_id = ?
    `)
      .bind(volunteerId)
      .run();

    await logDeletion(env, volunteerId, emailDigest, "soft");

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
  emailDigest: string,
  type: "soft" | "hard"
) {
  await env.CORE_DB.prepare(`
    INSERT INTO deletion_requests
    (request_id, volunteer_id, email, type, requested_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `)
    .bind(
      crypto.randomUUID(),
      volunteerId,
      emailDigest, // store the HMAC digest — never log plaintext email
      type
    )
    .run();
}

// ============================================================
//  CRYPTO HELPERS
// ============================================================

/**
 * HMAC-SHA256 keyed digest.
 * Deterministic — same email always produces the same digest,
 * but cannot be reversed to recover the original value without the key.
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
  const sig  = await crypto.subtle.sign("HMAC", key, data);

  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
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
//  RESPONSE HELPERS
// ============================================================

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number) {
  return jsonResponse({ error: message }, status);
}