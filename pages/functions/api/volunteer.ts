// ============================================================
//  REQUIRED ENVIRONMENT VARIABLES (Cloudflare Worker Secrets)
// ============================================================
//
//  TURNSTILE_SECURITY_KEY  — Cloudflare Turnstile secret key
//  RESEND_API_KEY        — Resend email API key
//  FIELD_ENCRYPT_KEY     — 32-byte hex string (64 hex chars) used for
//                          AES-256-GCM encryption of PII fields.
//                          Generate with: openssl rand -hex 32
//  FIELD_HMAC_KEY        — 32-byte hex string (64 hex chars) used for
//                          HMAC-SHA256 of the email address for
//                          deterministic deduplication lookups.
//                          Generate with: openssl rand -hex 32
//
// ============================================================
//  HOW FIELD ENCRYPTION WORKS
// ============================================================
//
//  Sensitive PII fields (name, email, phone, zip) are encrypted
//  with AES-256-GCM before being written to the database.
//
//  Each value is encrypted independently with a random 96-bit IV
//  (initialisation vector), producing a unique ciphertext every
//  time — even for identical inputs. The stored format is:
//
//    <base64(iv)>.<base64(ciphertext+authTag)>
//
//  To read a value, authorized systems call aesGcmDecrypt() with
//  the same FIELD_ENCRYPT_KEY. Without the key the ciphertext is
//  unreadable, even with direct database access.
//
//  Email deduplication uses a separate HMAC-SHA256 keyed with
//  FIELD_HMAC_KEY. The HMAC is deterministic (same email always
//  produces the same digest) so duplicate checks work without
//  decrypting any rows. The HMAC alone cannot be reversed to
//  recover the original email address.
//
// ============================================================

export async function onRequestPost(context: {
  request: Request;
  env: {
    CORE_DB?: any;
    TURNSTILE_SECURITY_KEY?: string;
    APP_ENV?: string;
    RESEND_API_KEY?: string;
    FIELD_ENCRYPT_KEY?: string;
    FIELD_HMAC_KEY?: string;
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

    if (!isDev && (!env.FIELD_ENCRYPT_KEY || !env.FIELD_HMAC_KEY)) {
      return jsonError("Server configuration error: missing encryption keys", 500);
    }

    // ----------------------------------------
    // Parse + validate body
    // ----------------------------------------
    interface VolunteerBody {
      name?: string;
      email?: string;
      phone?: string;
      zip?: string;
      interests?: unknown[];
      languages?: unknown[];
      consent?: boolean;
      form_type?: string;
      turnstileToken?: string;
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
      return jsonError("Content-Type must be application/json", 415);
    }

    const body = await request.json() as VolunteerBody;

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

    // ----------------------------------------
    // Input length + format validation
    // ----------------------------------------
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email.trim())) {
      return jsonError("Invalid email address", 400);
    }

    if (name.trim().length > 100) {
      return jsonError("Name must be 100 characters or fewer", 400);
    }

    if (email.trim().length > 254) {
      return jsonError("Email must be 254 characters or fewer", 400);
    }

    if (phone && phone.trim().length > 30) {
      return jsonError("Phone must be 30 characters or fewer", 400);
    }

    if (zip.trim().length > 10) {
      return jsonError("Zip must be 10 characters or fewer", 400);
    }

    // ----------------------------------------
    // Validate form_type against known values
    // ----------------------------------------
    const VALID_FORM_TYPES = ["volunteer_page", "issues_page", "unknown"] as const;
    type FormType = typeof VALID_FORM_TYPES[number];
    const safeFormType: FormType = VALID_FORM_TYPES.includes(form_type as FormType)
      ? form_type as FormType
      : "unknown";

    // ----------------------------------------
    // Validate interests + languages against allowlists
    // ----------------------------------------
    const VALID_INTERESTS = [
      "Phone banking",
      "Text banking",
      "Canvassing / Door knocking",
      "Events",
      "Social media",
      "I'm not sure yet",
      "Other"
    ];

    const VALID_LANGUAGES = [
      "Albanian", "Amharic", "Arabic", "Armenian", "Belarusian",
      "Bulgarian", "Bengali", "Cantonese", "Croatian", "Czech",
      "Danish", "Dutch", "Estonian", "Finnish", "French",
      "German", "Greek", "Gujarati", "Hebrew", "Hindi",
      "Hungarian", "Icelandic", "Indonesian", "Italian", "Japanese",
      "Khmer", "Korean", "Kurdish", "Latvian", "Lao",
      "Lithuanian", "Luxembourgish", "Macedonian", "Malay", "Maltese",
      "Mandarin", "Norwegian", "Polish", "Portuguese", "Punjabi",
      "Romanian", "Russian", "Serbian", "Slovak", "Slovenian",
      "Somali", "Spanish", "Swedish", "Swahili", "Tagalog",
      "Tamil", "Thai", "Turkish", "Ukrainian", "Urdu",
      "Vietnamese",
      "ASL (American Sign Language)",
      "Auslan (Australian Sign Language)",
      "BSL (British Sign Language)",
      "CSL (Chinese Sign Language)",
      "DGS (German Sign Language)",
      "IPSL (Indonesian Sign Language)",
      "ISL (Irish Sign Language)",
      "JSL (Japanese Sign Language)",
      "KSL (Korean Sign Language)",
      "LIS (Italian Sign Language)",
      "LSF (French Sign Language)",
      "LSQ (Quebec Sign Language)",
      "NZSL (New Zealand Sign Language)",
      "PNG (Papua New Guinea Sign Language)",
      "Other"
    ];

    const safeInterests = Array.isArray(interests)
      ? interests.filter((i): i is string =>
          typeof i === "string" && VALID_INTERESTS.includes(i)
        )
      : [];
    const safeLanguages = Array.isArray(languages)
      ? languages.filter((l): l is string =>
          typeof l === "string" && VALID_LANGUAGES.includes(l)
        )
      : [];
    const isVolunteerPage = safeFormType === "volunteer_page";

    if (isVolunteerPage && safeInterests.length === 0) {
      return jsonError("Please select at least one volunteer activity", 400);
    }

    // ----------------------------------------
    // Verify Turnstile
    // ----------------------------------------
    const verifyResponse = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECURITY_KEY,
          response: turnstileToken
        })
      }
    );

    const verifyData = await verifyResponse.json() as { success: boolean };

    if (!verifyData.success) {
      return new Response(JSON.stringify(verifyData), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // ----------------------------------------
    // Development mode — log, skip encryption
    // ----------------------------------------
    if (isDev) {
      console.log("DEV MODE submission (unencrypted):", body);
    }

    if (!env.CORE_DB) {
      return jsonError("CORE_DB not configured", 500);
    }

    // ----------------------------------------
    // Hashing + encryption helpers (scoped)
    // ----------------------------------------
    const encryptKey  = env.FIELD_ENCRYPT_KEY!;
    const hmacKey     = env.FIELD_HMAC_KEY!;

    /**
     * Encrypt a plaintext string with AES-256-GCM.
     * Returns "base64(iv).base64(ciphertext+authTag)".
     * In dev mode, returns the plaintext prefixed with "dev:" for clarity.
     */
    async function encryptField(value: string): Promise<string> {
      if (isDev) return `dev:${value}`;
      return aesGcmEncrypt(value, encryptKey);
    }

    /**
     * Produce a keyed HMAC-SHA256 digest of a value.
     * Used for the email deduplication lookup — deterministic
     * so the same email always maps to the same digest, but
     * the digest cannot be reversed to recover the email.
     */
    async function emailHmac(value: string): Promise<string> {
      if (isDev) return await sha256(value); // plain SHA-256 in dev is fine
      return hmacSha256(value.trim().toLowerCase(), hmacKey);
    }

    // ----------------------------------------
    // Prepare values
    // ----------------------------------------
    const now            = new Date().toISOString();
    const ip             = request.headers.get("CF-Connecting-IP") || "";
    const ipHash         = await sha256(ip);
    const rawPayloadHash = await sha256(JSON.stringify(body));

    const normalizedEmail = email.trim().toLowerCase();
    const emailDigest     = await emailHmac(normalizedEmail);

    // Encrypt each sensitive PII field independently
    const [encName, encEmail, encPhone, encZip] = await Promise.all([
      encryptField(name.trim()),
      encryptField(normalizedEmail),
      phone?.trim() ? encryptField(phone.trim()) : Promise.resolve(null),
      encryptField(zip.trim()),
    ]);

    // ----------------------------------------
    // Deduplication — keyed on HMAC of email
    // ----------------------------------------
    let volunteerId: string;

    const existing = await env.CORE_DB
      .prepare(`SELECT volunteer_id FROM volunteers WHERE email_hash = ?`)
      .bind(emailDigest)
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
          email_hash,
          phone,
          zip,
          consent,
          source_form,
          ip_hash,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
        .bind(
          volunteerId,
          encName,
          encEmail,
          emailDigest,
          encPhone,
          encZip,
          1,
          safeFormType,
          ipHash,
          now,
          now
        )
        .run();
    }

    // ----------------------------------------
    // Insert Interests
    // ----------------------------------------
    if (safeInterests.length > 0) {
      for (const interest of safeInterests) {
        await env.CORE_DB.prepare(
          `
          INSERT OR IGNORE INTO volunteer_interests (volunteer_id, interest)
          VALUES (?, ?)
          `
        )
          .bind(volunteerId, interest)
          .run();
      }
    }

    // ----------------------------------------
    // Insert Languages
    // ----------------------------------------
    if (safeLanguages.length > 0) {
      for (const language of safeLanguages) {
        await env.CORE_DB.prepare(
          `
          INSERT OR IGNORE INTO volunteer_languages (volunteer_id, language)
          VALUES (?, ?)
          `
        )
          .bind(volunteerId, language)
          .run();
      }
    }

    // ----------------------------------------
    // Insert Submission Record
    // ----------------------------------------
    const submissionId = crypto.randomUUID();
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

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
      .bind(submissionId, volunteerId, safeFormType, now, rawPayloadHash, verificationExpiresAt)
      .run();

    // ----------------------------------------
    // Send Verification Email
    // ----------------------------------------
    const baseUrl = new URL(request.url).origin;

    if (env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "no-reply@alexandriasofiakis.com",
          to: email,     // use the original plaintext email for sending
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
    // Log the full error server-side for debugging
    console.error("Volunteer submission error:", error);

    // In development expose the real message; in production return a generic one
    const message = isDev && error instanceof Error
      ? error.message
      : "An unexpected error occurred. Please try again.";

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// ============================================================
//  CRYPTO HELPERS
// ============================================================

/**
 * AES-256-GCM encryption.
 *
 * Generates a fresh random 96-bit IV for every call so that
 * identical plaintexts produce different ciphertexts.
 *
 * Stored format: "<base64(iv)>.<base64(ciphertext+authTag)>"
 *
 * To decrypt, call aesGcmDecrypt() with the same keyHex.
 */
async function aesGcmEncrypt(plaintext: string, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))); // 96-bit IV
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

/**
 * AES-256-GCM decryption.
 *
 * Accepts the "<base64(iv)>.<base64(ciphertext+authTag)>" format
 * produced by aesGcmEncrypt() and returns the original plaintext.
 *
 * Throws if the key is wrong or the ciphertext has been tampered with
 * (AES-GCM authentication tag verification will fail).
 */
export async function aesGcmDecrypt(encrypted: string, keyHex: string): Promise<string> {
  const [ivB64, cipherB64] = encrypted.split(".");
  if (!ivB64 || !cipherB64) throw new Error("Invalid encrypted format");

  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const iv         = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(cipherB64);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plainBuffer);
}

/**
 * HMAC-SHA256 keyed digest.
 *
 * Used for deterministic email deduplication. The same input always
 * produces the same hex digest, but the digest cannot be reversed to
 * recover the original value without the key.
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

/**
 * Plain SHA-256 digest (used for IP and raw payload fingerprinting).
 */
async function sha256(input: string): Promise<string> {
  const data       = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Encoding utilities ----

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const buf   = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf    = new ArrayBuffer(binary.length);
  const bytes  = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---- Response helper ----

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}