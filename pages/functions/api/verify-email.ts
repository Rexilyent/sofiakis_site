// =====================================================
// GET /api/verify-email?token=<submissionId>
// =====================================================
// Handles email verification link clicks.
// Looks up the submission token, checks expiry, marks
// the volunteer as verified, then redirects to the
// verify-email page with a status query param.

export async function onRequestGet(context: {
  request: Request;
  env: {
    CORE_DB?: any;
  };
}) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  const redirect = (status: string) =>
    Response.redirect(`${url.origin}/verify-email.html?status=${status}`, 302);

  if (!token) return redirect("invalid");
  if (!env.CORE_DB) return redirect("error");

  // -----------------------------
  // Look up the submission token
  // -----------------------------
  const submission = await env.CORE_DB
    .prepare(
      `SELECT volunteer_id, verification_expires_at
       FROM volunteer_submissions
       WHERE submission_id = ?`
    )
    .bind(token)
    .first();

  if (!submission) return redirect("invalid");

  // -----------------------------
  // Check expiry
  // -----------------------------
  if (new Date(submission.verification_expires_at) < new Date()) {
    return redirect("expired");
  }

  // -----------------------------
  // Check if already verified
  // -----------------------------
  const volunteer = await env.CORE_DB
    .prepare(
      `SELECT email_verified FROM volunteers WHERE volunteer_id = ?`
    )
    .bind(submission.volunteer_id)
    .first();

  if (!volunteer) return redirect("invalid");
  if (volunteer.email_verified) return redirect("already");

  // -----------------------------
  // Mark volunteer as verified
  // -----------------------------
  const now = new Date().toISOString();

  await env.CORE_DB
    .prepare(
      `UPDATE volunteers
       SET email_verified = 1,
           email_verified_at = ?,
           updated_at = ?
       WHERE volunteer_id = ?`
    )
    .bind(now, now, submission.volunteer_id)
    .run();

  return redirect("success");
}
