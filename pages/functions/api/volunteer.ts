export async function onRequestPost(context: {
  request: Request;
  env: {
    CORE_DB?: any;
    TURNSTILE_SECRET_KEY?: string;
    APP_ENV?: string;
    RESEND_API_KEY?: string;
    FROM_EMAIL?: string;
  };
}) {
  const { request, env } = context;

  try {
    if (!env.TURNSTILE_SECRET_KEY) {
      return jsonError("Server configuration error", 500);
    }

    const body = await request.json();

    const {
      name,
      email,
      phone,
      zip,
      interests,
      languages,
      consent,
      form_type,
      turnstileToken
    } = body;

    if (!turnstileToken) {
      return jsonError("Missing Turnstile token", 400);
    }

    if (!name || !email || !zip) {
      return jsonError("Name, email, and zip are required", 400);
    }

    if (!consent) {
      return jsonError("Consent required", 400);
    }

    const safeInterests = Array.isArray(interests)
      ? interests.filter(Boolean)
      : [];

    const safeLanguages = Array.isArray(languages)
      ? languages.filter(Boolean)
      : [];

    const isVolunteerPage = form_type === "volunteer_page";

    if (isVolunteerPage && safeInterests.length === 0) {
      return jsonError("Please select at least one volunteer activity", 400);
    }

    // -----------------------------
    // Verify Turnstile
    // -----------------------------
    const verifyResponse = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: turnstileToken
        })
      }
    );

    const verifyData = await verifyResponse.json();

    if (!verifyData.success) {
      return new Response(JSON.stringify(verifyData), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // -----------------------------
    // Development Mode
    // -----------------------------
    if (env.APP_ENV === "development") {
      console.log("DEV MODE submission:", body);
    }

    if (!env.CORE_DB) {
      return jsonError("CORE_DB not configured", 500);
    }

    let volunteerId;
    let isNewVolunteer = false;
    const now = new Date().toISOString();
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const ipHash = await sha256(ip);
    const rawPayloadHash = await sha256(JSON.stringify(body));

    // -----------------------------
    // Insert or Find Volunteer
    // -----------------------------
    const existing = await env.CORE_DB
      .prepare(`SELECT volunteer_id, email_verified FROM volunteers WHERE email = ?`)
      .bind(email.trim().toLowerCase())
      .first();

    if (existing?.volunteer_id) {
      volunteerId = existing.volunteer_id;
    } else {
      isNewVolunteer = true;
      volunteerId = crypto.randomUUID();

      await env.CORE_DB.prepare(
        `
        INSERT OR IGNORE INTO volunteers (
          volunteer_id,
          name,
          email,
          phone,
          zip,
          consent,
          source_form,
          ip_hash,
          email_verified,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `
      )
        .bind(
          volunteerId,
          name.trim(),
          email.trim().toLowerCase(),
          phone?.trim() || null,
          zip.trim(),
          1,
          form_type || "unknown",
          ipHash,
          now,
          now
        )
        .run();
    }

    // -----------------------------
    // Insert Interests
    // -----------------------------
    if (safeInterests.length > 0) {
      for (const interest of safeInterests) {
        await env.CORE_DB.prepare(
          `
          INSERT OR IGNORE INTO volunteer_interests (
            volunteer_id,
            interest
          )
          VALUES (?, ?)
          `
        )
          .bind(volunteerId, interest)
          .run();
      }
    }

    // -----------------------------
    // Insert Languages
    // -----------------------------
    if (safeLanguages.length > 0) {
      for (const language of safeLanguages) {
        await env.CORE_DB.prepare(
          `
          INSERT OR IGNORE INTO volunteer_languages (
            volunteer_id,
            language
          )
          VALUES (?, ?)
          `
        )
          .bind(volunteerId, language)
          .run();
      }
    }

    const submissionId = crypto.randomUUID();

    // Token expires 24 hours from now
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // -----------------------------
    // Insert Submission Record
    // -----------------------------
    await env.CORE_DB.prepare(
      `
      INSERT INTO volunteer_submissions (
        submission_id,
        volunteer_id,
        form_type,
        submitted_at,
        raw_payload_hash,
        verification_expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        submissionId,
        volunteerId,
        form_type || "unknown",
        now,
        rawPayloadHash,
        expiresAt
      )
      .run();

    // -----------------------------
    // Send Verification Email
    // (skip if already verified)
    // -----------------------------
    const alreadyVerified = existing?.email_verified === 1;

    if (!alreadyVerified) {
      const baseUrl = new URL(request.url).origin;
      const verifyUrl = `${baseUrl}/api/verify-email?token=${submissionId}`;
      const fromEmail = env.FROM_EMAIL || "no-reply@example.com";

      if (env.RESEND_API_KEY) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: email.trim(),
            subject: "Please confirm your volunteer sign-up — Alexandria Sofiakis for IL-10",
            html: buildVerificationEmail(name.trim(), verifyUrl)
          })
        });
      } else {
        console.error("RESEND_API_KEY not configured. Skipping email.");
      }
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error("Volunteer submission error:", error);

    const message =
      error instanceof Error ? error.message : "Internal Server Error";

    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}

// -----------------------------
// Email Template
// -----------------------------

function buildVerificationEmail(name: string, verifyUrl: string): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Confirm your volunteer sign-up</title>
    </head>
    <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

              <!-- Header -->
              <tr>
                <td style="background:#008037;padding:28px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">
                    Alexandria Sofiakis for IL-10
                  </p>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:40px 40px 32px;">
                  <p style="margin:0 0 16px;font-size:16px;color:#111111;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 16px;font-size:16px;color:#444444;line-height:1.6;">
                    Thank you for signing up to volunteer with our campaign! We're excited to have you on board.
                  </p>
                  <p style="margin:0 0 28px;font-size:16px;color:#444444;line-height:1.6;">
                    Please click the button below to confirm your email address. This link will expire in <strong>24 hours</strong>.
                  </p>

                  <!-- CTA Button -->
                  <table cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td align="center">
                        <a href="${verifyUrl}"
                           style="display:inline-block;background:#008037;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:600;">
                          Confirm My Email
                        </a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin:28px 0 0;font-size:13px;color:#888888;line-height:1.6;">
                    If the button doesn't work, copy and paste this link into your browser:<br>
                    <a href="${verifyUrl}" style="color:#008037;word-break:break-all;">${verifyUrl}</a>
                  </p>

                  <p style="margin:20px 0 0;font-size:13px;color:#888888;">
                    If you did not sign up to volunteer, you can safely ignore this email.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background:#f0f0f0;padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#999999;">
                    Paid for by Alexandria Sofiakis
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

// -----------------------------
// Helpers
// -----------------------------

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
