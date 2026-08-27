// ============================================================
//  STAFF PORTAL — CAMPAIGN TEAM  —  portal-team.js
// ============================================================
//
//  Who works on the campaign, what they do, and whether they have
//  portal access.
//
//  ── WHY THIS IS SEPARATE FROM THE VOLUNTEERS TAB ──────────
//
//  The volunteers table is sign-up submissions: people who filled
//  in a form. This is the standing team. Someone can appear in
//  both, and the two answer different questions — "who offered to
//  help" versus "who is doing the work".
//
//  ── PORTAL ACCESS IS SHOWN, NOT SET ───────────────────────
//
//  Access status is derived server-side from staff_accounts and
//  staff_invites, so it can never disagree with reality. Granting
//  it means sending an invitation the person must accept by
//  choosing their own password — adding someone here creates a
//  record and nothing else.
//
//  Editing requires the team:write capability (admin and superadmin
//  roles). The controls are hidden for anyone else as a courtesy; the
//  API enforces it with a 403 regardless of what the browser believes.
//
//  ── LINKING A STAFF ACCOUNT ────────────────────────────────
//
//  Accepting an invitation normally attaches the new account to a
//  team_members row automatically, matched on email. That has
//  nothing to match against if the row didn't exist yet — e.g. an
//  invite sent directly rather than through "Invite to Portal" here.
//  The "Linked staff account" field in the edit modal is the manual
//  fallback: pick an existing, unclaimed account, or clear a stale
//  one. It never creates an account — only /api/admin-invites (a
//  separate, superadmin-only capability) can do that.
//
// ============================================================

(function () {
  "use strict";

  const API = "/api/admin-team";
  const core = () => window.PortalCore || {};

  let initialised = false;
  let members = [];
  let canEdit = false;
  let statusFilter = "";
  let accessFilter = "";
  let editingId = null;
  let linkableAccounts = [];

  const $ = id => document.getElementById(id);

  const summaryEl  = $("team-summary");
  const statsEl    = $("team-stats");
  const loadingEl  = $("team-loading");
  const errorEl    = $("team-error");
  const errorMsgEl = $("team-error-msg");
  const emptyEl    = $("team-empty");
  const listEl     = $("team-list");
  const filtersEl  = $("team-filters");
  const addBtn     = $("team-add-btn");

  const overlay    = $("team-modal-overlay");
  const modalTitle = $("team-modal-title");
  const closeBtn   = $("team-modal-close");
  const saveBtn    = $("team-save-btn");
  const saveLabel  = $("team-save-label");
  const deleteBtn  = $("team-delete-btn");
  const formErr    = $("team-form-error");
  const formErrMsg = $("team-form-error-msg");

  const f = {
    name:       $("team-name"),
    title:      $("team-title"),
    team:       $("team-team"),
    engagement: $("team-engagement"),
    status:     $("team-status"),
    email:      $("team-email"),
    phone:      $("team-phone"),
    started:    $("team-started"),
    ended:      $("team-ended"),
    notes:      $("team-notes"),
    endedHint:  $("team-ended-hint"),
    staffAccount: $("team-staff-account")
  };
  const linkRow  = $("team-link-row");
  const linkHint = $("team-staff-account-hint");

  const TEAM_LABEL = {
    field: "Field", comms: "Communications", digital: "Digital",
    finance: "Finance", operations: "Operations", other: "Other"
  };
  const STATUS_LABEL = {
    prospect: "Prospect", onboarding: "Onboarding",
    active: "Active", former: "Former"
  };
  const ENGAGEMENT_LABEL = {
    staff: "Staff", volunteer: "Volunteer",
    contractor: "Contractor", intern: "Intern"
  };
  const ACCESS_LABEL = {
    active: "Portal access", invited: "Invited", none: "No portal access"
  };

  // ============================================================
  //  BOOT
  // ============================================================

  document.addEventListener("portal:tab", e => {
    if (e.detail?.tab !== "team") return;
    if (!initialised) { initialised = true; wire(); }
    fetchTeam();
  });

  function wire() {
    addBtn?.addEventListener("click", () => openModal(null));
    closeBtn?.addEventListener("click", closeModal);
    overlay?.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay && !overlay.hidden) closeModal();
    });
    saveBtn?.addEventListener("click", save);
    deleteBtn?.addEventListener("click", remove);

    // An end date is required for former members, so say so as soon as
    // the status is chosen rather than after a failed save.
    f.status?.addEventListener("change", () => {
      const isFormer = f.status.value === "former";
      if (f.endedHint) f.endedHint.textContent = isFormer ? "required" : "";
      if (isFormer && !f.ended.value) f.ended.focus();
    });

    filtersEl?.querySelectorAll(".cal-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        statusFilter = pill.dataset.status ?? "";
        accessFilter = pill.dataset.access ?? "";
        filtersEl.querySelectorAll(".cal-pill")
          .forEach(p => p.classList.toggle("is-active", p === pill));
        renderList();
      });
    });
  }

  // ============================================================
  //  LIST
  // ============================================================

  async function fetchTeam() {
    show(loadingEl); hide(errorEl); hide(emptyEl); hide(statsEl);
    listEl.innerHTML = "";

    try {
      const res = await core().authFetch(API);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Server returned ${res.status}`);
      }
      const data = await res.json();
      members = data.members || [];
      canEdit = !!data.can_edit;
      linkableAccounts = data.linkable_accounts || [];

      // Hide the write controls for people who can't use them, rather
      // than showing buttons that will 403.
      document.querySelectorAll(".team-edit-only")
        .forEach(el => { el.hidden = !canEdit; });

      $("team-stat-active").textContent     = data.counts?.active ?? 0;
      $("team-stat-onboarding").textContent = data.counts?.onboarding ?? 0;
      $("team-stat-access").textContent     = data.counts?.with_access ?? 0;
      $("team-stat-former").textContent     = data.counts?.former ?? 0;
      show(statsEl);

      renderList();

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      hide(loadingEl);
      errorMsgEl.textContent = err.message;
      show(errorEl);
    }
  }

  function renderList() {
    hide(loadingEl);

    let rows = members;
    if (statusFilter) rows = rows.filter(m => m.status === statusFilter);
    if (accessFilter) rows = rows.filter(m => m.portal_access === accessFilter);

    summaryEl.textContent = members.length
      ? `${members.length} ${members.length === 1 ? "person" : "people"}` +
        (rows.length !== members.length ? ` \u00b7 showing ${rows.length}` : "")
      : "Nobody listed yet.";

    listEl.innerHTML = "";
    if (!rows.length) {
      show(emptyEl);
      emptyEl.querySelector("p").textContent = members.length
        ? "Nobody matches this filter."
        : "Nobody listed yet. Choose \u201cAdd Person\u201d to start the directory.";
      return;
    }
    hide(emptyEl);

    for (const m of rows) {
      const li = document.createElement("li");
      li.className = "art-item";

      const dates = [
        m.started_at ? `from ${formatDate(m.started_at)}` : null,
        m.ended_at   ? `until ${formatDate(m.ended_at)}`  : null
      ].filter(Boolean).join(" ");

      li.innerHTML = `
        <div class="art-item-main">
          <div class="art-item-head">
            <span class="art-chip team-status-${esc(m.status)}">${esc(STATUS_LABEL[m.status] || m.status)}</span>
            <span class="art-chip team-access-${esc(m.portal_access)}">
              ${esc(ACCESS_LABEL[m.portal_access] || m.portal_access)}${
                m.portal_role ? ` \u00b7 ${esc(m.portal_role)}` : ""}
            </span>
            ${m.orphaned_link
              ? '<span class="art-chip staff-chip-revoked" title="Their login no longer exists">Login removed</span>'
              : ""}
            <span class="art-item-cat">${esc(ENGAGEMENT_LABEL[m.engagement] || m.engagement)}</span>
          </div>
          <h3 class="art-item-title"></h3>
          <p class="art-item-summary"></p>
          <p class="art-item-meta">
            ${esc(TEAM_LABEL[m.team] || m.team)}
            ${m.email ? `\u00b7 ${esc(m.email)}` : ""}
            ${dates ? `\u00b7 ${esc(dates)}` : ""}
            ${m.last_login_at ? `\u00b7 last signed in ${esc(formatDate(m.last_login_at))}` : ""}
          </p>
        </div>
        <div class="art-item-actions">
          ${canEdit ? `<button class="art-btn art-btn-ghost team-edit">
              <i class="fas fa-pen" aria-hidden="true"></i> Edit
            </button>` : ""}
          ${canEdit && m.portal_access === "none" && m.email
            ? `<button class="art-btn art-btn-secondary team-invite">
                 <i class="fas fa-envelope" aria-hidden="true"></i> Invite
               </button>` : ""}
        </div>`;

      li.querySelector(".art-item-title").textContent = m.full_name;
      li.querySelector(".art-item-summary").textContent = m.title || "";
      li.querySelector(".team-edit")?.addEventListener("click", () => openModal(m));
      li.querySelector(".team-invite")?.addEventListener("click", () => inviteMember(m));
      listEl.appendChild(li);
    }
  }

  /**
   * Hand off to the invite modal with the address pre-filled, rather
   * than duplicating the invitation flow here. portal-staff.js owns it.
   */
  function inviteMember(m) {
    const emailField = document.getElementById("staff-invite-email");
    const inviteBtn  = document.getElementById("staff-invite-btn");
    if (!emailField || !inviteBtn) {
      core().toast?.("The invitation form isn't available.", "error");
      return;
    }
    inviteBtn.click();
    emailField.value = m.email;
    core().toast?.(`Inviting ${m.full_name} \u2014 check the role before sending.`);
  }

  // ============================================================
  //  ADD / EDIT
  // ============================================================

  let returnFocus = null;

  function openModal(member) {
    clearFormError();
    editingId = member?.member_id || null;
    returnFocus = document.activeElement;

    modalTitle.textContent = member ? `Edit ${member.full_name}` : "Add a team member";
    saveLabel.textContent  = member ? "Save changes" : "Add Person";

    f.name.value       = member?.full_name  || "";
    f.title.value      = member?.title      || "";
    f.team.value       = member?.team       || "other";
    f.engagement.value = member?.engagement || "staff";
    f.status.value     = member?.status     || "active";
    f.email.value      = member?.email      || "";
    f.phone.value      = member?.phone      || "";
    f.started.value    = (member?.started_at || "").slice(0, 10);
    f.ended.value      = (member?.ended_at   || "").slice(0, 10);
    f.notes.value      = member?.notes      || "";
    if (f.endedHint) {
      f.endedHint.textContent = f.status.value === "former" ? "required" : "";
    }

    // Only meaningful for an existing row, and only populated from
    // data the server sends to team:write callers in the first place.
    if (linkRow) {
      const showLink = canEdit && !!member;
      linkRow.hidden = !showLink;
      if (showLink) populateLinkOptions(member);
    }

    // Removing a record is only offered where it is actually allowed:
    // someone with a live login must lose the login first.
    const removable = !!member && member.portal_access === "none";
    deleteBtn.hidden = !removable;

    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    core().trapFocus?.(overlay);
    f.name.focus();
  }

  /**
   * Build the "Linked staff account" options: the member's own
   * current link first (even if orphaned, so leaving it untouched on
   * save doesn't read as a different choice), then every account
   * nobody else has claimed.
   */
  function populateLinkOptions(member) {
    if (!f.staffAccount) return;
    f.staffAccount.innerHTML = '<option value="">\u2014 No linked account \u2014</option>';

    const seen = new Set();
    const addOption = (username, label) => {
      if (!username || seen.has(username)) return;
      seen.add(username);
      const opt = document.createElement("option");
      opt.value = username;
      opt.textContent = label;
      f.staffAccount.appendChild(opt);
    };

    if (member?.staff_username) {
      addOption(member.staff_username, member.orphaned_link
        ? `${member.staff_username} (account removed)`
        : `${member.staff_username}${member.portal_role ? ` \u2014 ${member.portal_role}` : ""}`);
    }
    for (const acct of linkableAccounts) {
      addOption(acct.username, `${acct.username} \u2014 ${acct.role}`);
    }

    f.staffAccount.value = member?.staff_username || "";

    if (linkHint) {
      linkHint.textContent = member?.orphaned_link
        ? "This login no longer exists. Pick a current account, or choose " +
          "\u201cNo linked account\u201d to clear it."
        : (!linkableAccounts.length && !member?.staff_username
            ? "No unclaimed staff accounts to link \u2014 invite them first."
            : "");
    }
  }

  function closeModal() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = "";
    core().releaseFocus?.(overlay);
    if (returnFocus && document.body.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
    editingId = null;
  }

  async function save() {
    clearFormError();

    const name = f.name.value.trim();
    if (!name) { showFormError("A name is required."); f.name.focus(); return; }

    if (f.status.value === "former" && !f.ended.value) {
      showFormError("Give an end date when marking someone as former \u2014 " +
                    "otherwise the directory can't answer who was here when.");
      f.ended.focus();
      return;
    }

    const payload = {
      full_name:  name,
      title:      f.title.value.trim(),
      team:       f.team.value,
      engagement: f.engagement.value,
      status:     f.status.value,
      email:      f.email.value.trim(),
      phone:      f.phone.value.trim(),
      started_at: f.started.value || null,
      ended_at:   f.ended.value || null,
      notes:      f.notes.value.trim()
    };
    if (editingId) {
      payload.member_id = editingId;
      // Only sent when editing, and only when the row is actually
      // shown -- omitting the key entirely leaves an existing link
      // untouched server-side, which matters if this ever gets
      // called from a path that doesn't render the link control.
      if (linkRow && !linkRow.hidden && f.staffAccount) {
        payload.staff_username = f.staffAccount.value;
      }
    }

    saveBtn.disabled = true;
    try {
      const res = await core().authFetch(API, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) { showFormError(data.error || `Server returned ${res.status}`); return; }

      core().toast?.(editingId ? "Team member updated." : `${name} added to the team.`);

      // Marking someone former does not revoke their login. Say so
      // rather than letting access quietly outlive the person.
      if (data.still_has_access) {
        core().toast?.(
          `${name} still has portal access as "${data.still_has_access}". ` +
          "Remove their login separately if they should lose it.", "warn", 12000);
      }

      closeModal();
      fetchTeam();

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      showFormError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function remove() {
    if (!editingId) return;
    const name = f.name.value.trim();
    if (!confirm(`Remove ${name} from the team directory?\n\n` +
                 "Their employment record and dates are deleted. This cannot be undone.")) return;

    try {
      const res = await core().authFetch(`${API}?id=${encodeURIComponent(editingId)}`,
        { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showFormError(data.error || `Could not remove (${res.status})`); return; }
      core().toast?.(`${name} removed from the directory.`);
      closeModal();
      fetchTeam();
    } catch (err) {
      if (!/Session expired/.test(err.message)) {
        showFormError("Couldn't reach the server.");
      }
    }
  }

  // ============================================================
  //  HELPERS
  // ============================================================

  function showFormError(msg) { formErrMsg.textContent = msg; show(formErr); }
  function clearFormError()   { hide(formErr); }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "\u2014";
    try {
      return new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric",
                                       timeZone: "UTC" });
    } catch { return iso; }
  }

  const show = el => { if (el) el.hidden = false; };
  const hide = el => { if (el) el.hidden = true; };

})();
