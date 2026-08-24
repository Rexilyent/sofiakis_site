// ============================================================
//  STAFF PORTAL — STAFF ACCESS  —  portal-staff.js
// ============================================================
//
//  Invite staff members, and see who has an outstanding, accepted,
//  expired or cancelled invitation.
//
//  ── ROLE VISIBILITY IS NOT SECURITY ───────────────────────
//
//  The Staff tab is hidden for anyone who isn't a superadmin, but
//  that is a courtesy, not a control: the role in sessionStorage
//  is client-side data and a determined user can edit it. Every
//  route in /api/admin-invites re-checks the role server-side and
//  answers 403 regardless of what the browser believes.
//
//  So hiding the tab is about not showing people buttons that
//  won't work — the actual boundary is in the Worker.
//
//  ── THE LINK IS A CREDENTIAL ──────────────────────────────
//
//  The sign-up link is shown after creating an invitation so it
//  can be passed on when email delivery fails. It is deliberately
//  shown ONCE, in the modal, and never stored in the invitations
//  list — the server only keeps its hash, so it could not be
//  re-displayed later even if we wanted to.
//
// ============================================================

(function () {
  "use strict";

  const API = "/api/admin-invites";
  const core = () => window.PortalCore || {};

  let initialised = false;
  let invites = [];

  const $ = id => document.getElementById(id);

  const tabBtn      = $("tab-staff");
  const summaryEl   = $("staff-summary");
  const statsEl     = $("staff-stats");
  const loadingEl   = $("staff-loading");
  const errorEl     = $("staff-error");
  const errorMsgEl  = $("staff-error-msg");
  const emptyEl     = $("staff-empty");
  const listEl      = $("staff-list");
  const emailWarn   = $("staff-email-warning");

  const inviteBtn   = $("staff-invite-btn");
  const overlay     = $("staff-invite-overlay");
  const closeBtn    = $("staff-invite-close");
  const formEl      = $("staff-invite-form");
  const emailEl     = $("staff-invite-email");
  const roleEl      = $("staff-invite-role");
  const sendBtn     = $("staff-invite-send");
  const sendLabel   = $("staff-invite-send-label");
  const inviteErr   = $("staff-invite-error");
  const inviteErrMsg = $("staff-invite-error-msg");
  const resultEl    = $("staff-invite-result");
  const resultTitle = $("staff-result-title");
  const resultMsg   = $("staff-result-msg");
  const linkEl      = $("staff-result-link");
  const copyBtn     = $("staff-copy-link");
  const againBtn    = $("staff-invite-another");

  // ── Show the tab only to superadmins ──────────────────────
  //  Runs on load rather than on tab switch, because the tab has to
  //  appear before anyone can click it.
  (function revealForSuperadmin() {
    const role = core().session?.role;
    if (role === "superadmin" && tabBtn) tabBtn.hidden = false;
  })();

  document.addEventListener("portal:tab", e => {
    if (e.detail?.tab !== "staff") return;
    if (!initialised) { initialised = true; wire(); }
    fetchInvites();
  });

  function wire() {
    inviteBtn?.addEventListener("click", openModal);
    closeBtn?.addEventListener("click", closeModal);
    overlay?.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay && !overlay.hidden) closeModal();
    });
    sendBtn?.addEventListener("click", sendInvite);
    againBtn?.addEventListener("click", resetModal);
    copyBtn?.addEventListener("click", copyLink);
    emailEl?.addEventListener("keydown", e => { if (e.key === "Enter") sendInvite(); });
  }

  // ============================================================
  //  LIST
  // ============================================================

  async function fetchInvites() {
    show(loadingEl); hide(errorEl); hide(emptyEl); hide(statsEl);
    listEl.innerHTML = "";

    try {
      const res = await core().authFetch(API);
      if (res.status === 403) {
        hide(loadingEl);
        errorMsgEl.textContent =
          "Only a superadmin can manage staff invitations.";
        show(errorEl);
        return;
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Server returned ${res.status}`);
      }

      const data = await res.json();
      invites = data.invites || [];

      $("staff-stat-pending").textContent  = data.counts?.pending  ?? 0;
      $("staff-stat-accepted").textContent = data.counts?.accepted ?? 0;
      $("staff-stat-expired").textContent  = data.counts?.expired  ?? 0;
      $("staff-stat-revoked").textContent  = data.counts?.revoked  ?? 0;
      show(statsEl);

      // Tell the superadmin up front, not after a failed send
      if (emailWarn) emailWarn.hidden = data.email_configured !== false;

      renderList();

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      hide(loadingEl);
      errorMsgEl.textContent = err.message;
      show(errorEl);
    }
  }

  const STATUS_LABEL = {
    pending:  "Awaiting sign-up",
    accepted: "Accepted",
    expired:  "Expired",
    revoked:  "Cancelled"
  };

  function renderList() {
    hide(loadingEl);
    summaryEl.textContent = invites.length
      ? `${invites.length} invitation${invites.length === 1 ? "" : "s"}`
      : "No invitations yet.";

    listEl.innerHTML = "";
    if (!invites.length) { show(emptyEl); return; }
    hide(emptyEl);

    for (const inv of invites) {
      const li = document.createElement("li");
      li.className = "art-item";
      li.innerHTML = `
        <div class="art-item-main">
          <div class="art-item-head">
            <span class="art-chip staff-chip-${inv.status}">${STATUS_LABEL[inv.status] || inv.status}</span>
            <span class="art-item-cat">${esc(inv.role)}</span>
          </div>
          <h3 class="art-item-title"></h3>
          <p class="art-item-meta">
            Invited by ${esc(inv.invited_by || "unknown")}
            · ${esc(formatDate(inv.created_at))}
            ${inv.status === "pending" ? `· expires ${esc(formatDate(inv.expires_at))}` : ""}
            ${inv.accepted_at ? `· accepted ${esc(formatDate(inv.accepted_at))}` : ""}
            ${inv.revoked_at ? `· cancelled by ${esc(inv.revoked_by || "unknown")}` : ""}
          </p>
        </div>
        <div class="art-item-actions">
          ${inv.status === "pending"
            ? `<button class="art-btn art-btn-danger staff-revoke" data-id="${esc(inv.invite_id)}">
                 <i class="fas fa-ban" aria-hidden="true"></i> Cancel
               </button>` : ""}
        </div>`;
      // textContent: an email address is data, not markup
      li.querySelector(".art-item-title").textContent = inv.email;
      li.querySelector(".staff-revoke")?.addEventListener("click", () => revoke(inv));
      listEl.appendChild(li);
    }
  }

  async function revoke(inv) {
    if (!confirm(`Cancel the invitation for ${inv.email}?\n\n` +
                 "Their sign-up link will stop working immediately.")) return;
    try {
      const res = await core().authFetch(`${API}?id=${encodeURIComponent(inv.invite_id)}`,
        { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        core().toast?.(d.error || `Could not cancel (${res.status})`, "error", 8000);
        return;
      }
      core().toast?.("Invitation cancelled.");
      fetchInvites();
    } catch (err) {
      if (!/Session expired/.test(err.message)) {
        core().toast?.("Couldn't reach the server.", "error");
      }
    }
  }

  // ============================================================
  //  INVITE MODAL
  // ============================================================

  let returnFocus = null;

  function openModal() {
    resetModal();
    returnFocus = inviteBtn;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    core().trapFocus?.(overlay);
    emailEl.focus();
  }

  function closeModal() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = "";
    core().releaseFocus?.(overlay);
    if (returnFocus && document.body.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
    fetchInvites();
  }

  function resetModal() {
    emailEl.value = "";
    roleEl.value = "admin";
    hide(inviteErr);
    hide(resultEl);
    show(formEl);
    setSending(false);
  }

  async function sendInvite() {
    hide(inviteErr);

    const email = emailEl.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      showInviteError("Enter a valid email address.");
      emailEl.focus();
      return;
    }

    setSending(true);
    try {
      const res = await core().authFetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: roleEl.value })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showInviteError(data.error || `Server returned ${res.status}`);
        return;
      }

      // Shown once. The server keeps only the hash, so this cannot be
      // recovered later — copy it now or send another invitation.
      linkEl.value = data.signup_url || "";

      if (data.emailed) {
        resultTitle.textContent = "Invitation sent";
        resultMsg.textContent =
          `An email is on its way to ${email}. The link below is the same one — ` +
          "keep it in case the email doesn't arrive.";
      } else {
        resultTitle.textContent = "Invitation created — send it yourself";
        resultMsg.textContent =
          `The email could not be sent (${data.email_error || "unknown reason"}). ` +
          `Send this link to ${email} through a channel you trust.`;
      }

      hide(formEl);
      show(resultEl);
      core().toast?.(data.emailed ? "Invitation sent." : "Invitation created.");

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      showInviteError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(linkEl.value);
      core().toast?.("Link copied.");
    } catch {
      // Clipboard access can be blocked; select it so Ctrl+C works
      linkEl.select();
      core().toast?.("Press Ctrl+C to copy the selected link.", "warn");
    }
  }

  function setSending(on) {
    if (!sendBtn) return;
    sendBtn.disabled = on;
    if (sendLabel) sendLabel.textContent = on ? "Sending…" : "Send Invitation";
  }

  function showInviteError(msg) {
    inviteErrMsg.textContent = msg;
    show(inviteErr);
  }

  // ── Helpers ───────────────────────────────────────────────

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-US",
        { month: "short", day: "numeric", year: "numeric" });
    } catch { return iso; }
  }

  const show = el => { if (el) el.hidden = false; };
  const hide = el => { if (el) el.hidden = true; };

})();
