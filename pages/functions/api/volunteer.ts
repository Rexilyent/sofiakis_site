export async function onRequestPost(context: {
  request: Request;
  env: {
    CORE_DB?: any;
    TURNSTILE_SECRET_KEY?: string;
    APP_ENV?: string;
		RESEND_API_KEY?: string;
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

		console.log("CORE_DB:", env.CORE_DB);

		let volunteerId;
    const now = new Date().toISOString();
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const ipHash = await sha256(ip);
    const rawPayloadHash = await sha256(JSON.stringify(body));

    // -----------------------------
    // Insert Volunteer
    // -----------------------------
    const existing = await env.CORE_DB
			.prepare(`SELECT volunteer_id FROM volunteers WHERE email = ?`)
			.bind(email.trim().toLowerCase())
			.first();

		if (existing?.volunteer_id) {
			volunteerId = existing.volunteer_id;
		} else {
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
        	created_at,
        	updated_at
      	)
      	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		if(safeInterests.length > 0) {
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
		if(safeLanguages.length > 0) {
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
        raw_payload_hash
      )
      VALUES (?, ?, ?, ?, ?)
      `
    )
      .bind(
        submissionId,
        volunteerId,
        form_type || "unknown",
        now,
        rawPayloadHash
      )
      .run();

		// -----------------------------
		// Send Verification Email
		// -----------------------------
		const baseUrl = new URL(request.url).origin;

		if (env.RESEND_API_KEY) {
			await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${env.RESEND_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					from: "no-reply@example.com",
					to: email,
					subject: "Please confirm your volunteer sign-up",
					html: `
						<p>Thank you for signing up to volunteer!</p>
						<p>Please confirm your email by clicking below:</p>
						<a href="${baseUrl}/verify-email?token=${submissionId}">Confirm Email</a>
						<p>If you did not sign up, please ignore this email.</p>
						<p>This link will expire in 24 hours.</p>
					`
				})
			});
		} else {
			console.error("RESEND_API_KEY not configured. Skipping email sending.");
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
// Helpers
// -----------------------------

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

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