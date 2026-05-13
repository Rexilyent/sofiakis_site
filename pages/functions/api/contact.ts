// ============================================================
//  POST /api/contact
// ============================================================
//
//  REQUIRED ENVIRONMENT VARIABLES (Cloudflare Worker Secrets)
//
//  TURNSTILE_SECURITY_KEY  — Cloudflare Turnstile secret key
//  RESEND_API_KEY        — Resend email API key
//  CONTACT_TO_EMAIL      — Address that receives contact messages
//  CONTACT_FROM_EMAIL    — Verified sender address in Resend
//
// ============================================================

export async function onRequestPost(context: {
  request: Request;
  env: {
    TURNSTILE_SECURITY_KEY?: string;
    RESEND_API_KEY?: string;
    CONTACT_TO_EMAIL?: string;
    CONTACT_FROM_EMAIL?: string;
    APP_ENV?: string;
  };
}) {
  const { request, env } = context;

  // Declared outside try so catch block can access it for error messaging
  const isDev = env.APP_ENV === "development";

  try {
    // ----------------------------------------
    // Guard: required secrets
    // ----------------------------------------
    if (!env.TURNSTILE_SECURITY_KEY) {
      return jsonError("Server configuration error: missing Turnstile key", 500);
    }

    if (!env.RESEND_API_KEY) {
      return jsonError("Server configuration error: missing email key", 500);
    }

    if (!env.CONTACT_TO_EMAIL || !env.CONTACT_FROM_EMAIL) {
      return jsonError("Server configuration error: missing contact email addresses", 500);
    }

    // ----------------------------------------
    // Parse + validate body
    // ----------------------------------------
    interface ContactBody {
      name?: string;
      email?: string;
      subject?: string;
      message?: string;
      token?: string;
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
      return jsonError("Content-Type must be application/json", 415);
    }

    const body = await request.json() as ContactBody;
    const { name, email, subject, message, token } = body;

    if (!name?.trim())    return jsonError("Name is required", 400);
    if (!email?.trim())   return jsonError("Email is required", 400);
    if (!subject?.trim()) return jsonError("Subject is required", 400);
    if (!message?.trim()) return jsonError("Message is required", 400);
    if (!token)           return jsonError("Missing Turnstile token", 400);

    if (message.trim().length > 1000) {
      return jsonError("Message must be 1000 characters or fewer", 400);
    }

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email.trim())) {
      return jsonError("Invalid email address", 400);
    }

    // ----------------------------------------
    // Verify Turnstile
    // ----------------------------------------
    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECURITY_KEY,
          response: token,
        }),
      }
    );

    const verifyData = await verifyRes.json() as { success: boolean };

    if (!verifyData.success) {
      return jsonError("Security verification failed. Please try again.", 403);
    }

    // ----------------------------------------
    // Send email via Resend
    // ----------------------------------------
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.CONTACT_FROM_EMAIL,
        to:   env.CONTACT_TO_EMAIL,
        reply_to: email.trim(),
        subject: `[Contact Form] ${subject.trim()}`,
        html: `
          <p><strong>Name:</strong> ${escapeHtml(name.trim())}</p>
          <p><strong>Email:</strong> ${escapeHtml(email.trim())}</p>
          <p><strong>Subject:</strong> ${escapeHtml(subject.trim())}</p>
          <hr />
          <p>${escapeHtml(message.trim()).replace(/\n/g, "<br>")}</p>
        `,
      }),
    });

    if (!sendRes.ok) {
      console.error("Resend error:", await sendRes.text());
      return jsonError("Failed to send message. Please try again.", 500);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Contact form error:", err);
    const message = isDev && err instanceof Error
      ? err.message
      : "An unexpected error occurred. Please try again.";
    return jsonError(message, 500);
  }
}

// ============================================================
//  HELPERS
// ============================================================

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}