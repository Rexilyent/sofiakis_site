// =====================================================
//  DATA DELETION REQUEST
// =====================================================
//
//  One script, two mount points:
//
//    1. Any element with [data-delete-request] opens a modal that runs
//       stage 1 — enter an address, receive a link and code by email.
//
//    2. If #delete-me-page exists, this script renders the flow into it
//       directly. With ?token= in the URL it renders stage 2 (confirm);
//       without one it renders stage 1, so the page also works as a
//       standalone entry point to link from the privacy policy.
//
//  Everything is wrapped in an IIFE. volunteer.js declares
//  TURNSTILE_SITE_KEY and API_BASE at the top level of a classic script,
//  which puts them in the global lexical scope — re-declaring either name
//  here would be a SyntaxError and would stop this whole file loading on
//  every page that includes both.
//
//  No inline event handlers anywhere: everything binds via
//  addEventListener, so nothing here stands in the way of dropping
//  'unsafe-inline' from the CSP.

(function () {
  "use strict";

  // Public site key. Must match the one in volunteer.js.
  var SITE_KEY = "0x4AAAAAADGm0uPo8ej66jcz";
  var ENDPOINT = "/api/delete-me";

  // =====================================================
  //  SMALL DOM HELPERS
  // =====================================================

  // Builds elements from properties rather than innerHTML. Nothing the
  // user types is ever parsed as markup this way.
  function el(tag, props, children) {
    var node = document.createElement(tag);

    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === "class") node.className = props[key];
        else if (key === "text") node.textContent = props[key];
        else if (key === "html") node.innerHTML = props[key];
        else node.setAttribute(key, props[key]);
      });
    }

    (children || []).forEach(function (child) {
      node.appendChild(child);
    });

    return node;
  }

  function field(id, labelText, opts) {
    opts = opts || {};

    var input = el("input", {
      type: opts.type || "text",
      id: id,
      name: id,
      autocomplete: opts.autocomplete || "off",
      maxlength: opts.maxlength || "254"
    });

    if (opts.placeholder) input.setAttribute("placeholder", opts.placeholder);
    if (opts.inputmode) input.setAttribute("inputmode", opts.inputmode);
    if (opts.className) input.className = opts.className;

    var wrap = el("div", { class: "dr-field" }, [
      el("label", { for: id, text: labelText }),
      input
    ]);

    if (opts.hint) {
      var hintId = id + "-hint";
      wrap.appendChild(el("p", { class: "dr-hint", id: hintId, text: opts.hint }));
      input.setAttribute("aria-describedby", hintId);
    }

    return { wrap: wrap, input: input };
  }

  // =====================================================
  //  TURNSTILE
  // =====================================================
  //
  //  Rendered visibly inside each form, the way contact.js does it. A
  //  token is single-use, so every failed attempt resets the widget —
  //  otherwise a mistyped code burns the token and the second try fails
  //  for a reason that has nothing to do with the code.

  function waitForTurnstile(maxWait) {
    maxWait = maxWait || 5000;

    return new Promise(function (resolve, reject) {
      var start = Date.now();

      (function check() {
        if (typeof turnstile !== "undefined") {
          resolve(turnstile);
        } else if (Date.now() - start > maxWait) {
          reject(new Error("Turnstile failed to load."));
        } else {
          requestAnimationFrame(check);
        }
      })();
    });
  }

  function mountTurnstile(container, onToken) {
    var widgetId = null;

    waitForTurnstile().then(function () {
      widgetId = turnstile.render(container, {
        sitekey: SITE_KEY,
        callback: function (token) { onToken(token); },
        "expired-callback": function () { onToken(null); },
        "error-callback": function () { onToken(null); }
      });
    }).catch(function (err) {
      console.error(err);
      container.textContent =
        "Security check failed to load. Please refresh the page.";
    });

    return {
      reset: function () {
        if (widgetId !== null && typeof turnstile !== "undefined") {
          turnstile.reset(widgetId);
        }
        onToken(null);
      }
    };
  }

  // =====================================================
  //  API
  // =====================================================

  function post(payload) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json()
        .catch(function () { return {}; })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || "Request failed");
            err.status = res.status;
            throw err;
          }
          return data;
        });
    });
  }

  // =====================================================
  //  STAGE 1 — REQUEST A DELETION LINK
  // =====================================================

  function renderRequestForm(container, opts) {
    opts = opts || {};
    container.textContent = "";

    var heading = el(opts.headingTag || "h2", {
      class: "dr-heading",
      text: "Delete my information"
    });

    var intro = el("p", {
      class: "dr-intro",
      text:
        "Enter the email address you signed up with. We'll send that " +
        "address a link and a short code. Your information stays in our " +
        "records until you open the link and enter the code, so nobody " +
        "can remove your data without access to your inbox."
    });

    var emailField = field("dr-email", "Email address", {
      type: "email",
      autocomplete: "email",
      placeholder: "you@example.com"
    });

    var turnstileBox = el("div", { class: "dr-turnstile" });
    var message = el("p", {
      class: "dr-message",
      role: "status",
      "aria-live": "polite"
    });

    var submit = el("button", {
      type: "submit",
      class: "btn btn-primary dr-submit",
      text: "Send confirmation email"
    });

    var actions = el("div", { class: "dr-actions" }, [submit]);

    if (opts.onCancel) {
      var cancel = el("button", {
        type: "button",
        class: "btn btn-outline dr-cancel",
        text: "Cancel"
      });
      cancel.addEventListener("click", opts.onCancel);
      actions.appendChild(cancel);
    }

    var form = el("form", { class: "dr-form", novalidate: "novalidate" }, [
      emailField.wrap,
      turnstileBox,
      message,
      actions
    ]);

    container.appendChild(heading);
    container.appendChild(intro);
    container.appendChild(form);

    var token = null;
    var widget = mountTurnstile(turnstileBox, function (t) { token = t; });
    var busy = false;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;

      var email = emailField.input.value.trim();

      if (!email || email.indexOf("@") === -1) {
        setMessage(message, "Please enter a valid email address.", true);
        emailField.input.focus();
        return;
      }

      if (!token) {
        setMessage(message, "Please complete the security check first.", true);
        return;
      }

      busy = true;
      submit.disabled = true;
      setMessage(message, "Sending…", false);

      post({ action: "request", email: email, turnstileToken: token })
        .then(function (data) {
          renderSentState(container, data.message, opts);
        })
        .catch(function (err) {
          console.error(err);
          setMessage(
            message,
            err.status === 429
              ? "Too many attempts. Please wait a minute and try again."
              : "We couldn't send that email. Please try again shortly.",
            true
          );
          busy = false;
          submit.disabled = false;
          widget.reset();
        });
    });

    setTimeout(function () { emailField.input.focus(); }, 50);
  }

  // Deliberately identical whether or not the address was on file — the
  // server will not say, and neither will this.
  function renderSentState(container, message, opts) {
    container.textContent = "";

    container.appendChild(
      el("div", { class: "dr-icon", "aria-hidden": "true", text: "✉️" })
    );
    container.appendChild(
      el(opts.headingTag || "h2", {
        class: "dr-heading",
        text: "Check your inbox"
      })
    );
    container.appendChild(
      el("p", {
        text: message || "If that address is in our records, we've sent a " +
          "confirmation email with a link and a code."
      })
    );
    container.appendChild(
      el("p", {
        class: "dr-hint",
        text: "The link and code expire in 30 minutes. If nothing arrives, " +
          "check your spam folder."
      })
    );

    if (opts.onCancel) {
      var close = el("button", {
        type: "button",
        class: "btn btn-outline",
        text: "Close"
      });
      close.addEventListener("click", opts.onCancel);
      container.appendChild(close);
    }
  }

  // =====================================================
  //  STAGE 2 — CONFIRM WITH THE EMAILED CODE
  // =====================================================

  function renderConfirmForm(container, token, opts) {
    opts = opts || {};
    container.textContent = "";

    container.appendChild(
      el(opts.headingTag || "h1", {
        class: "dr-heading",
        text: "Confirm deletion"
      })
    );
    container.appendChild(
      el("p", {
        class: "dr-intro",
        text:
          "Re-enter the email address you signed up with, along with the " +
          "code from the email we just sent you."
      })
    );

    var emailField = field("dr-confirm-email", "Email address", {
      type: "email",
      autocomplete: "email",
      placeholder: "you@example.com"
    });

    var codeField = field("dr-confirm-code", "Confirmation code", {
      autocomplete: "one-time-code",
      placeholder: "XXXX-XXXX",
      maxlength: "12",
      inputmode: "text",
      className: "dr-code-input",
      hint: "Case doesn't matter, and you can leave the hyphen in or out."
    });

    var warning = el("p", {
      class: "dr-warning",
      text:
        "This cannot be undone. Your volunteer record will be removed and " +
        "the campaign will stop contacting you."
    });

    var turnstileBox = el("div", { class: "dr-turnstile" });
    var message = el("p", {
      class: "dr-message",
      role: "status",
      "aria-live": "polite"
    });

    var submit = el("button", {
      type: "submit",
      class: "btn btn-primary dr-submit dr-danger",
      text: "Delete my information"
    });

    var form = el("form", { class: "dr-form", novalidate: "novalidate" }, [
      emailField.wrap,
      codeField.wrap,
      warning,
      turnstileBox,
      message,
      el("div", { class: "dr-actions" }, [submit])
    ]);

    container.appendChild(form);

    var tsToken = null;
    var widget = mountTurnstile(turnstileBox, function (t) { tsToken = t; });
    var busy = false;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;

      var email = emailField.input.value.trim();
      var code = codeField.input.value.trim();

      if (!email || !code) {
        setMessage(message, "Please fill in both fields.", true);
        return;
      }

      if (!tsToken) {
        setMessage(message, "Please complete the security check first.", true);
        return;
      }

      busy = true;
      submit.disabled = true;
      setMessage(message, "Verifying…", false);

      post({
        action: "confirm",
        token: token,
        email: email,
        code: code,
        turnstileToken: tsToken
      })
        .then(function (data) {
          renderDoneState(container, data.message, opts);
        })
        .catch(function (err) {
          console.error(err);
          setMessage(
            message,
            err.status === 429
              ? "Too many attempts. Please wait a minute and try again."
              : (err.message || "That didn't work. Please try again."),
            true
          );
          busy = false;
          submit.disabled = false;
          // The Turnstile token has been spent by the failed attempt.
          widget.reset();
        });
    });

    setTimeout(function () { emailField.input.focus(); }, 50);
  }

  function renderDoneState(container, message, opts) {
    container.textContent = "";

    container.appendChild(
      el("div", { class: "dr-icon", "aria-hidden": "true", text: "✅" })
    );
    container.appendChild(
      el(opts.headingTag || "h1", { class: "dr-heading", text: "All done" })
    );
    container.appendChild(
      el("p", {
        text: message || "Your information has been removed from our records."
      })
    );

    var home = el("a", { class: "btn btn-primary", href: "/" });
    home.textContent = "Back to home";
    container.appendChild(home);
  }

  function setMessage(node, text, isError) {
    node.textContent = text;
    node.classList.toggle("is-error", !!isError);
  }

  // =====================================================
  //  MODAL
  // =====================================================

  var dialog = null;
  var dialogBody = null;
  var lastFocused = null;

  function ensureDialog() {
    if (dialog) return dialog;

    dialogBody = el("div", { class: "dr-modal-body" });

    var close = el("button", {
      type: "button",
      class: "dr-modal-close",
      "aria-label": "Close"
    });
    close.textContent = "×";
    close.addEventListener("click", closeDialog);

    dialog = el("dialog", {
      class: "dr-modal",
      "aria-label": "Delete my information"
    }, [close, dialogBody]);

    // Clicking the backdrop closes. The dialog element reports clicks on
    // its own padding box as clicks on the dialog itself, so compare
    // against the target rather than trusting the event to bubble from
    // some backdrop node — there isn't one in the DOM.
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) closeDialog();
    });

    dialog.addEventListener("close", function () {
      if (lastFocused && typeof lastFocused.focus === "function") {
        lastFocused.focus();
      }
      dialogBody.textContent = "";
    });

    document.body.appendChild(dialog);
    return dialog;
  }

  function openDialog() {
    lastFocused = document.activeElement;
    var d = ensureDialog();

    renderRequestForm(dialogBody, {
      headingTag: "h2",
      onCancel: closeDialog
    });

    if (typeof d.showModal === "function") {
      d.showModal();
    } else {
      // <dialog> is supported everywhere current, but a browser without
      // it would otherwise show an invisible, unusable form.
      d.setAttribute("open", "open");
    }
  }

  function closeDialog() {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  // =====================================================
  //  BOOTSTRAP
  // =====================================================

  document.addEventListener("DOMContentLoaded", function () {

    // --- Triggers on the sign-up forms ---
    var triggers = document.querySelectorAll("[data-delete-request]");
    Array.prototype.forEach.call(triggers, function (trigger) {
      trigger.addEventListener("click", function (e) {
        e.preventDefault();
        openDialog();
      });
    });

    // --- Standalone page ---
    var page = document.getElementById("delete-me-page");
    if (!page) return;

    var params = new URLSearchParams(window.location.search);
    var token = params.get("token");

    if (token) {
      renderConfirmForm(page, token, { headingTag: "h1" });

      // Drop the token from the address bar. It stays in this tab's
      // session state either way, but this keeps it out of anything that
      // reads location.href afterwards, and out of the URL a supporter
      // might copy to a friend or paste into a support request.
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } else {
      renderRequestForm(page, { headingTag: "h1" });
    }
  });

})();
