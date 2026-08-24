// ============================================================
//  STAFF SIGN-UP  —  staff-signup.js
// ============================================================
//
//  Drives /staff-signup.html: validates the invitation token,
//  collects a username and password, and creates the account.
//
//  ── THE TOKEN IS A CREDENTIAL ─────────────────────────────
//
//  It arrives in the URL, which means it can end up in browser
//  history, in a shared screenshot, or in a Referer header. Two
//  things are done about that:
//
//    1. It is removed from the address bar immediately after being
//       read, via history.replaceState — so a screenshot of the
//       filled-in form doesn't leak a working invitation.
//    2. The page is marked noindex, and the server never echoes
//       the invited email address back.
//
//  All real validation is server-side. The live rule checks below
//  exist so someone isn't told their password is wrong only after
//  submitting it.
//
// ============================================================

(function () {
  "use strict";

  const API = "/api/staff-signup";

  const $ = id => document.getElementById(id);

  const checkingEl = $("signup-checking");
  const invalidEl  = $("signup-invalid");
  const invalidTxt = $("signup-invalid-text");
  const invalidTitle = $("signup-invalid-title");
  const formWrap   = $("signup-form-wrap");
  const doneEl     = $("signup-done");
  const doneText   = $("signup-done-text");

  const form       = $("signup-form");
  const usernameEl = $("signup-username");
  const passwordEl = $("signup-password");
  const confirmEl  = $("signup-confirm");
  const roleEl     = $("signup-role");
  const minLenEl   = $("signup-minlen");
  const rulesEl    = $("signup-rules");
  const errorEl    = $("signup-error");
  const errorText  = $("signup-error-text");
  const submitBtn  = $("signup-btn");
  const togglePw   = $("signup-toggle-pw");

  let token = "";
  let minLength = 12;

  // ── Read and hide the token ───────────────────────────────
  (function readToken() {
    const params = new URLSearchParams(window.location.search);
    token = params.get("token") || "";

    // Strip it from the visible URL. The value is already captured;
    // this only affects what's displayed, bookmarked and screenshotted.
    // dev-fixtures.js only defines __DEV_FIXTURES__ on localhost with
    // ?dev=1. Supplying a placeholder token there lets this page be
    // developed without minting a real invitation; anywhere else the
    // global is undefined and this does nothing.
    if (!token && window.__DEV_FIXTURES__) {
      token = "d".repeat(64);
      console.warn("[DEV FIXTURES] Using a placeholder invitation token.");
    }

    if (token && window.history?.replaceState) {
      const clean = window.location.pathname;
      window.history.replaceState({}, document.title, clean);
    }
  })();

  // ── 1. Is the invitation usable? ──────────────────────────

  (async function checkInvite() {
    if (!token) {
      // Landing here without a token usually means the page was opened
      // directly rather than through an invitation. That is not the same
      // as a rejected invitation, and saying so avoids implying the
      // person's link is broken when they never had one.
      showInvalid(
        "This page can only be opened from an invitation link. If you were " +
        "sent one, open it directly from your email \u2014 copying only part of " +
        "the address will drop the token.",
        "An invitation link is required");
      return;
    }

    try {
      const res = await fetch(`${API}?token=${encodeURIComponent(token)}`);
      let data = null;
      try { data = await res.json(); } catch { data = null; }

      if (!data) {
        showInvalid("The sign-up service returned an unexpected response " +
                    `(${res.status}). Please contact the campaign technical team.`);
        return;
      }
      if (!data.valid) {
        showInvalid(data.error || "This invitation is no longer valid.");
        return;
      }

      if (data.role && roleEl) roleEl.textContent = data.role;
      if (data.min_password_length) {
        minLength = data.min_password_length;
        if (minLenEl) minLenEl.textContent = String(minLength);
      }

      show(formWrap);
      hide(checkingEl);
      usernameEl.focus();
      updateRules();

    } catch {
      showInvalid("Couldn't reach the sign-up service. Check your connection " +
                  "and reload the page.");
    }
  })();

  // ── 2. Live rule feedback ─────────────────────────────────

  function passwordChecks() {
    const pw = passwordEl.value;
    const classes = [
      /[a-z]/.test(pw), /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^a-zA-Z0-9]/.test(pw)
    ].filter(Boolean).length;
    return {
      length:  pw.length >= minLength,
      classes: classes >= 3,
      match:   pw.length > 0 && pw === confirmEl.value
    };
  }

  function updateRules() {
    const checks = passwordChecks();
    rulesEl?.querySelectorAll("li").forEach(li => {
      const ok = checks[li.dataset.rule];
      li.classList.toggle("is-met", !!ok);
      const icon = li.querySelector("i");
      if (icon) icon.className = ok ? "fas fa-circle-check" : "fas fa-circle";
    });
  }

  [passwordEl, confirmEl].forEach(el => el?.addEventListener("input", () => {
    updateRules();
    clearError();
  }));
  usernameEl?.addEventListener("input", clearError);

  togglePw?.addEventListener("click", () => {
    const showing = passwordEl.type === "text";
    passwordEl.type = showing ? "password" : "text";
    togglePw.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    const icon = togglePw.querySelector("i");
    if (icon) icon.className = showing ? "fas fa-eye" : "fas fa-eye-slash";
  });

  // ── 3. Submit ─────────────────────────────────────────────

  form?.addEventListener("submit", async e => {
    e.preventDefault();
    clearError();

    const username = usernameEl.value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      showError("Username must be 3–32 characters: letters, numbers, dot, " +
                "underscore or hyphen.");
      usernameEl.focus();
      return;
    }

    const checks = passwordChecks();
    if (!checks.length)  { showError(`Password must be at least ${minLength} characters.`); return; }
    if (!checks.classes) { showError("Password must mix at least three of: lowercase, " +
                                     "uppercase, numbers, symbols."); return; }
    if (!checks.match)   { showError("The two passwords don't match."); return; }

    setLoading(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, username, password: passwordEl.value })
      });

      let data = null;
      try { data = await res.json(); } catch { data = null; }

      if (!data) {
        showError(`The sign-up service returned an unexpected response (${res.status}).`);
        return;
      }
      if (!res.ok || !data.success) {
        showError(data.error || "Couldn't create the account. Please try again.");
        return;
      }

      // Clear the credentials from memory before showing the confirmation
      passwordEl.value = "";
      confirmEl.value  = "";
      token = "";

      doneText.textContent = data.message ||
        `Your account is ready. Sign in as ${data.username}.`;
      hide(formWrap);
      show(doneEl);

    } catch {
      showError("Couldn't reach the sign-up service. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  });

  // ── Helpers ───────────────────────────────────────────────

  function setLoading(on) {
    if (!submitBtn) return;
    submitBtn.disabled = on;
    submitBtn.querySelector(".login-btn-text").hidden = on;
    submitBtn.querySelector(".login-btn-spinner").hidden = !on;
  }

  function showError(msg) {
    if (!errorEl) return;
    errorText.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    if (errorEl) errorEl.hidden = true;
  }

  function showInvalid(msg, title) {
    if (invalidTitle && title) invalidTitle.textContent = title;
    if (invalidTxt) invalidTxt.textContent = msg;
    hide(checkingEl);
    hide(formWrap);
    show(invalidEl);
  }

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

})();
