// ============================================================
//  LOGIN PAGE  —  login.js
// ============================================================
//
//  Flow:
//    1. On load — if a valid (non-expired) session token already
//       exists in sessionStorage, skip straight to the portal.
//    2. On submit — POST credentials to /api/admin-auth.
//       On success, store the token + metadata in sessionStorage
//       then redirect to /portal.html.
//    3. On failure — show the appropriate error banner.
//
//  sessionStorage is used intentionally:
//    - Clears automatically when the browser tab is closed.
//    - Never persisted to disk like localStorage would be.
//    - Scoped to the current tab / origin.
//
// ============================================================

(function () {
  "use strict";

  const PORTAL_URL   = "/portal.html";
  const AUTH_API     = "/api/admin-auth";
  const SESSION_KEY  = "staffSession";

  // ── On load: redirect if already authenticated ─────────────
  (function checkExistingSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const session = JSON.parse(raw);
      if (session?.token && session?.expires_at) {
        if (new Date(session.expires_at) > new Date()) {
          window.location.replace(PORTAL_URL);
        } else {
          // Expired — clean up
          sessionStorage.removeItem(SESSION_KEY);
        }
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  })();

  // ── DOM references ─────────────────────────────────────────
  const usernameInput  = document.getElementById("username");
  const passwordInput  = document.getElementById("password");
  const loginBtn       = document.getElementById("login-btn");
  const btnText        = loginBtn.querySelector(".login-btn-text");
  const btnSpinner     = loginBtn.querySelector(".login-btn-spinner");
  const errorBanner    = document.getElementById("login-error");
  const errorText      = document.getElementById("login-error-text");
  const lockoutBanner  = document.getElementById("login-lockout");
  const lockoutText    = document.getElementById("login-lockout-text");
  const togglePwBtn    = document.getElementById("toggle-pw");

  // ── Password visibility toggle ─────────────────────────────
  togglePwBtn.addEventListener("click", () => {
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    togglePwBtn.querySelector("i").className = isHidden
      ? "fas fa-eye-slash"
      : "fas fa-eye";
    togglePwBtn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
  });

  // ── Submit on Enter key ────────────────────────────────────
  [usernameInput, passwordInput].forEach(el => {
    el.addEventListener("keydown", e => {
      if (e.key === "Enter") handleLogin();
    });
  });

  // ── Submit button click ────────────────────────────────────
  loginBtn.addEventListener("click", handleLogin);

  // ── Clear error banners when user starts typing ────────────
  [usernameInput, passwordInput].forEach(el => {
    el.addEventListener("input", clearErrors);
  });

  // ── Main login handler ─────────────────────────────────────
  async function handleLogin() {
    clearErrors();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showError("Please enter both your username and password.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(AUTH_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });

      // Parse defensively. A 404 HTML page, a 500 with a plain-text
      // body, or an empty response all make res.json() throw -- and
      // that used to land in the catch below, reporting "unable to
      // reach the server" for a server that answered perfectly well.
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!data) {
        showError(describeNonJsonResponse(res.status));
        return;
      }

      if (res.status === 429) {
        // Brute-force lockout
        const retryAfter = res.headers.get("Retry-After");
        const mins = retryAfter ? Math.ceil(parseInt(retryAfter, 10) / 60) : null;
        showLockout(
          mins
            ? `Too many failed attempts. Account locked for ${mins} minute${mins === 1 ? "" : "s"}.`
            : "Too many failed attempts. Please try again later."
        );
        return;
      }

      if (!res.ok || !data.token) {
        showError(data.error || "Invalid username or password. Please try again.");
        // Shake the card on wrong credentials
        shakeCard();
        return;
      }

      // ── Success — persist session, redirect ──────────────
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        token:      data.token,
        expires_at: data.expires_at,
        username:   data.username,
        role:       data.role
      }));

      // Clear the password field before navigating
      passwordInput.value = "";

      window.location.replace(PORTAL_URL);

    } catch (err) {
      // Only genuine network failures reach here now: DNS, offline,
      // TLS, CORS. A server that responded is handled above.
      console.error("Login request failed:", err);
      showError(navigator.onLine
        ? "Couldn't reach the login service. It may be starting up — wait a moment and try again."
        : "You appear to be offline. Reconnect and try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── UI helpers ─────────────────────────────────────────────

  function setLoading(on) {
    loginBtn.disabled = on;
    btnText.hidden    = on;
    btnSpinner.hidden = !on;
  }

  function showError(message) {
    errorText.textContent = message;
    errorBanner.hidden    = false;
    lockoutBanner.hidden  = true;
    usernameInput.setAttribute("aria-invalid", "true");
    passwordInput.setAttribute("aria-invalid", "true");
  }

  function showLockout(message) {
    lockoutText.textContent = message;
    lockoutBanner.hidden    = false;
    errorBanner.hidden      = true;
    loginBtn.disabled       = true;
  }

  function clearErrors() {
    errorBanner.hidden  = true;
    lockoutBanner.hidden = true;
    usernameInput.removeAttribute("aria-invalid");
    passwordInput.removeAttribute("aria-invalid");
    loginBtn.disabled = false;
  }

  function shakeCard() {
    const card = document.querySelector(".login-card");
    card.classList.remove("shake");
    // Force reflow so re-adding the class restarts the animation
    void card.offsetWidth;
    card.classList.add("shake");
    card.addEventListener("animationend", () => card.classList.remove("shake"), { once: true });
  }


  /**
   * The server replied, but not with JSON. The status tells us roughly
   * what went wrong, and saying so beats a generic connection error --
   * these three cases need completely different fixes.
   */
  function describeNonJsonResponse(status) {
    if (status === 404) {
      return "The login service wasn't found (404). The site's functions may not be deployed.";
    }
    if (status === 500 || status === 502 || status === 503) {
      return `The login service returned an error (${status}). This usually means a ` +
             "server-side problem rather than a wrong password — check the Worker logs.";
    }
    if (status === 0) {
      return "The request was blocked before it completed. Check your connection.";
    }
    return `Unexpected response from the login service (${status}). Please tell the technical team.`;
  }

})();