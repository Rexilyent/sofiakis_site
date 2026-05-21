/* ============================================================
   BASE JS — shared across all pages
   ============================================================ */

// ---- Mobile nav drawer ----
(function () {
  // Ensure overlay element exists in the DOM
  function getOverlay() {
    let overlay = document.getElementById("nav-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "nav-overlay";
      overlay.className = "nav-overlay";
      overlay.setAttribute("aria-hidden", "true");
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  // Inject a close button inside the drawer (once)
  function ensureCloseBtn(drawer) {
    if (drawer.querySelector(".nav-drawer-close")) return;
    const btn = document.createElement("button");
    btn.className = "nav-drawer-close";
    btn.setAttribute("aria-label", "Close navigation");
    btn.setAttribute("type", "button");
    btn.innerHTML = "&#x2715;";
    btn.addEventListener("click", closeNav);
    drawer.insertBefore(btn, drawer.firstChild);
  }

  // Inject social icons at the bottom of the drawer (once)
  function ensureSocialIcons(drawer) {
    if (drawer.querySelector(".mobile-nav-social")) return;
    const source = document.querySelector(".nav-social");
    if (!source) return;
    const social = document.createElement("div");
    social.className = "mobile-nav-social";
    social.innerHTML = source.innerHTML;
    drawer.appendChild(social);
  }

  function openNav() {
    const drawer  = document.getElementById("nav-links");
    const toggle  = document.querySelector(".nav-toggle");
    const overlay = getOverlay();
    if (!drawer) return;

    // Move drawer to <body> so it escapes the site-header stacking context.
    // While inside site-header (z-index:2000 stacking context), the overlay
    // paints over it regardless of the drawer's own z-index. As a direct
    // child of body it gets its own independent stacking layer.
    if (drawer.parentElement !== document.body) {
      drawer._origParent  = drawer.parentElement;
      drawer._origSibling = drawer.nextSibling;
      document.body.appendChild(drawer);
    }

    ensureCloseBtn(drawer);
    ensureSocialIcons(drawer);

    drawer.classList.add("open");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
    toggle && toggle.setAttribute("aria-expanded", "true");

    const firstFocusable = drawer.querySelector("button, a, [tabindex]");
    if (firstFocusable) firstFocusable.focus();
  }

  function closeNav() {
    const drawer  = document.getElementById("nav-links");
    const toggle  = document.querySelector(".nav-toggle");
    const overlay = getOverlay();
    if (!drawer) return;

    drawer.classList.remove("open");
    overlay.classList.remove("active");
    document.body.style.overflow = "";
    toggle && toggle.setAttribute("aria-expanded", "false");
    toggle && toggle.focus();

    // Return drawer to its original position inside the header
    if (drawer._origParent) {
      drawer._origParent.insertBefore(drawer, drawer._origSibling || null);
      drawer._origParent  = null;
      drawer._origSibling = null;
    }

    drawer.querySelectorAll(".nav-dropdown.mobile-open")
          .forEach(d => d.classList.remove("mobile-open"));
  }

  function initAccordions(drawer) {
    drawer.querySelectorAll(".nav-dropdown > a").forEach(link => {
      if (link.dataset.mobileInit) return;
      link.dataset.mobileInit = "1";
      link.addEventListener("click", function (e) {
        if (window.innerWidth > 800) return;
        e.preventDefault();
        const dropdown = this.closest(".nav-dropdown");
        const isOpen   = dropdown.classList.toggle("mobile-open");
        this.setAttribute("aria-expanded", isOpen);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    const drawer  = document.getElementById("nav-links");
    const toggle  = document.querySelector(".nav-toggle");
    const overlay = getOverlay();

    if (!drawer || !toggle) return;

    toggle.removeAttribute("onclick");
    toggle.addEventListener("click", function () {
      drawer.classList.contains("open") ? closeNav() : openNav();
    });

    overlay.addEventListener("click", closeNav);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drawer.classList.contains("open")) closeNav();
    });

    initAccordions(drawer);
  });

  window.toggleNav = function () {
    const drawer = document.getElementById("nav-links");
    drawer && drawer.classList.contains("open") ? closeNav() : openNav();
  };
})();

/* ============================================================
   ACCESSIBILITY TOOLBAR
   ============================================================
   Injects a panel that lets users choose a visual
   comfort mode and toggle individual accessibility features.
   All preferences are persisted to localStorage so they
   survive page navigation.
   ============================================================ */

(function () {
  "use strict";

  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------
  const STORAGE_KEY = "a11y_prefs";

  const defaults = {
    mode:         "default",   // "default" | "comfort" | "highcontrast" | "dark"
    largeText:    false,
    dyslexiaFont: "none",  // "none" | "od" | "bda"
    reduceMotion: false,
    underline:    false,
    highlightLinks: false,
    focus:        false,
    tint:         "none",      // "none" | "cream" | "blue" | "green" | "rose"
    language:     "en",         // BCP-47 code, e.g. "es", "pl", "ko"
    colorVision:  "none",       // "none" | "grayscale" | "colorsafe"
  };

  let prefs = Object.assign({}, defaults);

  function loadPrefs() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) prefs = Object.assign({}, defaults, JSON.parse(stored));
    } catch (_) {}
  }

  function savePrefs() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  // ----------------------------------------------------------
  // Apply preferences to <html>
  // ----------------------------------------------------------
  const MODES    = ["default", "comfort", "highcontrast", "dark"];
  const TOGGLES  = ["largeText", "reduceMotion", "underline", "highlightLinks", "focus"];
  const CSS_MAP  = {
    largeText:    "a11y-large",
    reduceMotion: "a11y-reduce-motion",
    underline:    "a11y-underline",
    highlightLinks: "a11y-highlight-links",
    focus:        "a11y-focus",
  };
  const MODE_CSS = {
    comfort:      "a11y-comfort",
    highcontrast: "a11y-highcontrast",
    dark:         "a11y-dark",
  };

  const TINT_COLORS = {
    cream: "rgba(255, 243, 200, 1)",
    blue:  "rgba(180, 210, 255, 1)",
    green: "rgba(180, 230, 200, 1)",
    rose:  "rgba(255, 200, 210, 1)",
  };


  // ----------------------------------------------------------
  // Language data
  // ----------------------------------------------------------
  // Each entry: { code, name (English), native (self-label), rtl? }
  // Chosen based on IL-10 district demographics and the outreach
  // languages already listed in the volunteer form.
  const LANGUAGES = [
    { code: "en",    name: "English",    native: "English"      },
    { code: "es",    name: "Spanish",    native: "Español"      },
    { code: "pl",    name: "Polish",     native: "Polski"       },
    { code: "ko",    name: "Korean",     native: "한국어"        },
    { code: "zh-CN", name: "Chinese",    native: "中文"          },
    { code: "hi",    name: "Hindi",      native: "हिन्दी"       },
    { code: "tl",    name: "Filipino",   native: "Filipino"     },
    { code: "ar",    name: "Arabic",     native: "العربية", rtl: true },
    { code: "uk",    name: "Ukrainian",  native: "Українська"   },
    { code: "ja",    name: "Japanese",   native: "日本語"        },
    { code: "vi",    name: "Vietnamese", native: "Tiếng Việt"   },
    { code: "he",    name: "Hebrew",     native: "עברית", rtl: true },
    { code: "gu",    name: "Gujarati",   native: "ગુજરાતી"     },
    { code: "ru",    name: "Russian",    native: "Русский"      },
    { code: "am",    name: "Amharic",    native: "አማርኛ"        },
    { code: "bn",    name: "Bengali",    native: "বাংলা"        },
  ];

  // ── Pre-translated pages ────────────────────────────────────
  // Add a language code to this array once its hand-translated
  // pages are deployed at /[code]/[page].html  (e.g. /es/about.html).
  // The selector will route to those pages instead of using
  // Google Translate for any code listed here.
  const TRANSLATED_LANGS = [
    // "es",
    // "pl",
  ];

  // ── Google Translate loader ─────────────────────────────────
  // Injects the GT element once, on first non-English selection.
  let gtLoaded     = false;
  let gtLoadPromise = null;

  function loadGoogleTranslate() {
    if (gtLoaded) return Promise.resolve();
    if (gtLoadPromise) return gtLoadPromise;

    gtLoadPromise = new Promise(resolve => {
      // Hidden mount-point required by the GT library
      if (!document.getElementById("google_translate_element")) {
        const el = document.createElement("div");
        el.id = "google_translate_element";
        document.body.appendChild(el);
      }

      window.googleTranslateElementInit = function () {
        new google.translate.TranslateElement({
          pageLanguage: "en",
          autoDisplay:  false,
        }, "google_translate_element");
        gtLoaded = true;
        resolve();
      };

      const s = document.createElement("script");
      s.src   = "//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
      s.onerror = () => { gtLoadPromise = null; resolve(); };
      document.head.appendChild(s);
    });

    return gtLoadPromise;
  }

  // Apply a Google Translate language via the hidden combo box.
  // Retries briefly because the GT widget may not have rendered yet.
  function applyGoogleTranslate(langCode, attempt) {
    attempt = attempt || 0;
    const select = document.querySelector(".goog-te-combo");
    if (select) {
      select.value = langCode === "en" ? "" : langCode;
      select.dispatchEvent(new Event("change"));
    } else if (attempt < 20) {
      setTimeout(() => applyGoogleTranslate(langCode, attempt + 1), 150);
    }
  }

  // ── Main language-change handler ────────────────────────────
  function applyLanguage(code) {
    if (!code || code === "en") {
      // Restore English — if GT is loaded, reset it; otherwise no-op
      if (gtLoaded) applyGoogleTranslate("en");
      // If we navigated away from a translated path, go back to root
      const m = location.pathname.match(/^\/([a-z]{2}(-[A-Z]{2})?)\//);
      if (m && TRANSLATED_LANGS.includes(m[1])) {
        location.href = location.pathname.replace(/^\/[^/]+/, "") || "/";
      }
      return;
    }

    // Check for a hand-translated version first
    if (TRANSLATED_LANGS.includes(code)) {
      // Build the equivalent URL under /[code]/
      // e.g.  /about.html  →  /es/about.html
      const stripped = location.pathname.replace(/^\/([a-z]{2}(-[A-Z]{2})?\/)?/, "/");
      location.href  = "/" + code + stripped;
      return;
    }

    // Fall back to Google Translate
    loadGoogleTranslate().then(() => applyGoogleTranslate(code));
  }

  function applyPrefs() {
    const html = document.documentElement;

    // Mode classes
    MODES.forEach(m => {
      if (MODE_CSS[m]) html.classList.remove(MODE_CSS[m]);
    });
    if (MODE_CSS[prefs.mode]) html.classList.add(MODE_CSS[prefs.mode]);

    // Toggle classes
    TOGGLES.forEach(t => {
      html.classList.toggle(CSS_MAP[t], !!prefs[t]);
    });

    // Tint overlay
    const overlay = document.getElementById("a11y-tint-overlay");
    if (overlay) {
      if (prefs.tint && prefs.tint !== "none") {
        overlay.style.background = TINT_COLORS[prefs.tint] || "transparent";
        overlay.style.opacity    = "0.13";
      } else {
        overlay.style.opacity = "0";
      }
    }

    // Color vision classes (mutually exclusive)
    document.documentElement.classList.remove("a11y-grayscale", "a11y-colorsafe");
    if (prefs.colorVision === "grayscale") document.documentElement.classList.add("a11y-grayscale");
    if (prefs.colorVision === "colorsafe") document.documentElement.classList.add("a11y-colorsafe");

    // Dyslexia font classes (mutually exclusive)
    document.documentElement.classList.remove("a11y-dyslexia-od", "a11y-dyslexia-bda");
    if (prefs.dyslexiaFont === "od")  document.documentElement.classList.add("a11y-dyslexia-od");
    if (prefs.dyslexiaFont === "bda") document.documentElement.classList.add("a11y-dyslexia-bda");

    // Sync panel UI if it exists
    syncPanelUI();
  }

  function syncPanelUI() {
    // Mode buttons
    document.querySelectorAll(".a11y-mode-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === prefs.mode);
      btn.setAttribute("aria-pressed", btn.dataset.mode === prefs.mode);
    });

    // Toggles
    TOGGLES.forEach(t => {
      const el = document.getElementById("a11y-" + t);
      if (el) el.checked = !!prefs[t];
    });

    // Color vision buttons
    document.querySelectorAll(".a11y-cv-btn").forEach(btn => {
      const active = btn.dataset.cv === prefs.colorVision;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active);
    });

    // Language buttons
    document.querySelectorAll(".a11y-lang-btn").forEach(btn => {
      const active = btn.dataset.lang === prefs.language;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active);
    });

    // Dyslexia font buttons
    document.querySelectorAll(".a11y-font-btn").forEach(btn => {
      const active = btn.dataset.font === prefs.dyslexiaFont;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active);
    });

    // Tint buttons
    document.querySelectorAll(".a11y-tint-btn").forEach(btn => {
      const active = btn.dataset.tint === prefs.tint;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active);
    });
  }

  // ----------------------------------------------------------
  // Build toolbar HTML
  // ----------------------------------------------------------
  function buildToolbar() {
    // Skip nav link
    if (!document.querySelector(".skip-nav")) {
      const skip = document.createElement("a");
      skip.className   = "skip-nav";
      skip.href        = "#main-content";
      skip.textContent = "Skip to main content";
      document.body.insertAdjacentElement("afterbegin", skip);
    }

    // Tint overlay
    if (!document.getElementById("a11y-tint-overlay")) {
      const overlay = document.createElement("div");
      overlay.id = "a11y-tint-overlay";
      document.body.appendChild(overlay);
    }

    // Trigger button — injected into nav-social so it sits
    // alongside the social icons in the site header.
    if (!document.getElementById("a11y-trigger")) {
      const btn = document.createElement("button");
      btn.id               = "a11y-trigger";
      btn.setAttribute("aria-label",    "Open accessibility options");
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-controls", "a11y-panel");
      btn.title            = "Accessibility options";
      btn.innerHTML        = '<i class="fas fa-universal-access" aria-hidden="true"></i>';
      btn.addEventListener("click", togglePanel);

      // Find nav-social — prefer the one inside site-header so we
      // don't accidentally target a footer copy.
      const navSocial = document.querySelector(".site-header .nav-social")
                     || document.querySelector(".nav-social");

      if (navSocial) {
        // Insert before the first social link so it leads the group
        // and is reached early in the tab order within the nav.
        navSocial.insertAdjacentElement("afterbegin", btn);
      } else {
        // Fallback: if no nav-social found, append to body
        document.body.appendChild(btn);
      }
    }

    // Panel
    if (!document.getElementById("a11y-panel")) {
      const panel = document.createElement("div");
      panel.id                = "a11y-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Accessibility settings");
      panel.setAttribute("aria-modal", "false");
      panel.hidden            = true;

      panel.innerHTML = `
        <div class="a11y-panel-header">
          <h2>Accessibility</h2>
          <button class="a11y-panel-close" aria-label="Close accessibility panel" id="a11y-close">
            <i class="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <div class="a11y-panel-body">

          <p class="a11y-section-label">Display mode</p>
          <div class="a11y-mode-row" role="group" aria-label="Choose a display mode">
            <button class="a11y-mode-btn" data-mode="default"      aria-pressed="false" type="button">
              <i class="fas fa-circle-half-stroke" aria-hidden="true"></i>Default
            </button>
            <button class="a11y-mode-btn" data-mode="comfort"      aria-pressed="false" type="button">
              <i class="fas fa-sun" aria-hidden="true"></i>Comfort
            </button>
            <button class="a11y-mode-btn" data-mode="highcontrast" aria-pressed="false" type="button">
              <i class="fas fa-adjust" aria-hidden="true"></i>High contrast
            </button>
            <button class="a11y-mode-btn" data-mode="dark"         aria-pressed="false" type="button">
              <i class="fas fa-moon" aria-hidden="true"></i>Dark
            </button>
          </div>

          <div class="a11y-divider"></div>

          <p class="a11y-section-label">Color vision</p>
          <div class="a11y-mode-row" role="group" aria-label="Choose a color vision mode">
            <button class="a11y-mode-btn a11y-cv-btn" data-cv="none"
              aria-pressed="false" type="button">
              <i class="fas fa-eye" aria-hidden="true"></i>Default
            </button>
            <button class="a11y-mode-btn a11y-cv-btn" data-cv="grayscale"
              aria-pressed="false" type="button">
              <i class="fas fa-circle-half-stroke" aria-hidden="true"></i>Grayscale
            </button>
            <button class="a11y-mode-btn a11y-cv-btn" data-cv="colorsafe"
              aria-pressed="false" type="button">
              <i class="fas fa-droplet" aria-hidden="true"></i>Color-safe
            </button>
          </div>
          <p class="a11y-cv-note">
            <i class="fas fa-info-circle" aria-hidden="true"></i>
            Grayscale removes all color. Color-safe replaces green with
            blue &amp; amber — readable across all common color vision types.
          </p>

          <div class="a11y-divider"></div>

          <p class="a11y-section-label">Reading aids</p>

          <div class="a11y-tint-row" role="group" aria-label="Choose a reading tint overlay">
            <span class="a11y-tint-label"><i class="fas fa-palette" aria-hidden="true"></i>Reading tint</span>
            <button class="a11y-tint-btn" data-tint="none"  aria-label="No tint"    aria-pressed="false" type="button"
              style="background:#e0e0e0; border-color:#999;" title="None">✕</button>
            <button class="a11y-tint-btn" data-tint="cream" aria-label="Cream tint" aria-pressed="false" type="button"
              style="background:#fff3c8;" title="Cream"></button>
            <button class="a11y-tint-btn" data-tint="blue"  aria-label="Blue tint"  aria-pressed="false" type="button"
              style="background:#b4d2ff;" title="Blue"></button>
            <button class="a11y-tint-btn" data-tint="green" aria-label="Green tint" aria-pressed="false" type="button"
              style="background:#b4e6c8;" title="Green"></button>
            <button class="a11y-tint-btn" data-tint="rose"  aria-label="Rose tint"  aria-pressed="false" type="button"
              style="background:#ffc8d2;" title="Rose"></button>
          </div>

          <label class="a11y-toggle-row">
            <span class="a11y-toggle-label">
              <i class="fas fa-text-height" aria-hidden="true"></i>Larger text
            </span>
            <span class="a11y-switch">
              <input type="checkbox" id="a11y-largeText" role="switch" aria-label="Larger text">
              <span class="a11y-slider"></span>
            </span>
          </label>

          <div>
            <p class="a11y-section-label" style="margin-bottom:0.45rem;">
              <i class="fas fa-font" aria-hidden="true" style="margin-right:0.4rem;color:#555;font-size:0.85rem;"></i>
              Reading font
            </p>
            <div class="a11y-mode-row" role="group" aria-label="Choose a reading font" style="grid-template-columns:repeat(3,1fr);">
              <button class="a11y-mode-btn a11y-font-btn" data-font="none" aria-pressed="false" type="button"
                style="font-size:0.72rem;">
                <i class="fas fa-times" aria-hidden="true"></i>Default<span style="font-size:0.65rem;color:#888;">(Lexend)</span>
              </button>
              <button class="a11y-mode-btn a11y-font-btn" data-font="od" aria-pressed="false" type="button"
                style="font-size:0.72rem;">
                <i class="fas fa-font" aria-hidden="true"></i>OpenDyslexic<span style="font-size:0.65rem;color:#888;">visual</span>
              </button>
              <button class="a11y-mode-btn a11y-font-btn" data-font="bda" aria-pressed="false" type="button"
                style="font-size:0.72rem;">
                <i class="fas fa-align-left" aria-hidden="true"></i>BDA Sans<span style="font-size:0.65rem;color:#888;">Arial</span>
              </button>
            </div>
          </div>

          <div class="a11y-divider"></div>

          <p class="a11y-section-label">Motion & navigation</p>

          <label class="a11y-toggle-row">
            <span class="a11y-toggle-label">
              <i class="fas fa-circle-pause" aria-hidden="true"></i>Reduce motion
            </span>
            <span class="a11y-switch">
              <input type="checkbox" id="a11y-reduceMotion" role="switch" aria-label="Reduce motion">
              <span class="a11y-slider"></span>
            </span>
          </label>

          <label class="a11y-toggle-row">
            <span class="a11y-toggle-label">
              <i class="fas fa-link" aria-hidden="true"></i>Underline all links
            </span>
            <span class="a11y-switch">
              <input type="checkbox" id="a11y-underline" role="switch" aria-label="Underline all links">
              <span class="a11y-slider"></span>
            </span>
          </label>

          <label class="a11y-toggle-row">
            <span class="a11y-toggle-label">
              <i class="fas fa-highlighter" aria-hidden="true"></i>Highlight body links
            </span>
            <span class="a11y-switch">
              <input type="checkbox" id="a11y-highlightLinks" role="switch" aria-label="Highlight body links">
              <span class="a11y-slider"></span>
            </span>
          </label>

          <label class="a11y-toggle-row">
            <span class="a11y-toggle-label">
              <i class="fas fa-border-all" aria-hidden="true"></i>Enhanced focus rings
            </span>
            <span class="a11y-switch">
              <input type="checkbox" id="a11y-focus" role="switch" aria-label="Enhanced focus rings">
              <span class="a11y-slider"></span>
            </span>
          </label>

          <div class="a11y-divider"></div>

          <div>
            <p class="a11y-section-label" style="margin-bottom:0.5rem;">
              <i class="fas fa-globe" aria-hidden="true" style="margin-right:0.4rem;color:#555;font-size:0.85rem;"></i>
              Language / Idioma / 言語
            </p>

            <div class="a11y-lang-grid" role="group" aria-label="Select site language" id="a11y-lang-grid">
              <!-- Populated by JS from LANGUAGES array -->
            </div>

            <p class="a11y-lang-note">
              <i class="fas fa-info-circle" aria-hidden="true"></i>
              Translations powered by Google Translate.
              Hand-translated pages are coming soon for key languages.
            </p>
          </div>

          <div class="a11y-divider"></div>

          <button class="a11y-reset-btn" id="a11y-reset" type="button">
            Reset all settings to default
          </button>

        </div>
      `;

      document.body.appendChild(panel);

      // Populate language grid from LANGUAGES array
      const langGrid = document.getElementById("a11y-lang-grid");
      if (langGrid) {
        LANGUAGES.forEach(lang => {
          const isTranslated = TRANSLATED_LANGS.includes(lang.code);
          const btn = document.createElement("button");
          btn.type                  = "button";
          btn.className             = "a11y-lang-btn";
          btn.dataset.lang          = lang.code;
          btn.setAttribute("aria-pressed", "false");
          btn.setAttribute("aria-label",
            lang.name + (isTranslated ? " (translated page available)" : " (Google Translate)")
          );
          btn.innerHTML = `
            <span class="a11y-lang-native">${lang.native}</span>
            <span class="a11y-lang-en">${lang.name}${isTranslated ? ' <i class="fas fa-check-circle" aria-hidden="true" style="color:#008037;font-size:0.65rem;"></i>' : ''}</span>
          `;
          btn.addEventListener("click", () => {
            prefs.language = lang.code;
            savePrefs();
            syncPanelUI();
            applyLanguage(lang.code);
          });
          langGrid.appendChild(btn);
        });
      }

      // Wire up mode buttons
      panel.querySelectorAll(".a11y-mode-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          prefs.mode = btn.dataset.mode;
          savePrefs();
          applyPrefs();
        });
      });

      // Wire up color vision buttons
      panel.querySelectorAll(".a11y-cv-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          prefs.colorVision = btn.dataset.cv;
          savePrefs();
          applyPrefs();
        });
      });

      // Wire up dyslexia font buttons
      panel.querySelectorAll(".a11y-font-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          prefs.dyslexiaFont = btn.dataset.font;
          savePrefs();
          applyPrefs();
        });
      });

      // Wire up tint buttons
      panel.querySelectorAll(".a11y-tint-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          prefs.tint = btn.dataset.tint;
          savePrefs();
          applyPrefs();
        });
      });

      // Wire up toggles
      TOGGLES.forEach(t => {
        const el = document.getElementById("a11y-" + t);
        if (el) {
          el.addEventListener("change", () => {
            prefs[t] = el.checked;
            savePrefs();
            applyPrefs();
          });
        }
      });

      // Close button
      document.getElementById("a11y-close").addEventListener("click", closePanel);

      // Reset
      document.getElementById("a11y-reset").addEventListener("click", () => {
        prefs = Object.assign({}, defaults);
        savePrefs();
        applyPrefs();
      });

      // Close on outside click — exclude the trigger and its icon child
      document.addEventListener("click", e => {
        const trigger = document.getElementById("a11y-trigger");
        const clickedTrigger = trigger && (e.target === trigger || trigger.contains(e.target));
        if (!panel.contains(e.target) && !clickedTrigger) closePanel();
      });

      // Close on Escape
      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && panel.classList.contains("a11y-open")) {
          closePanel();
          document.getElementById("a11y-trigger").focus();
        }
      });
    }

    // Sync UI to current prefs
    syncPanelUI();
  }

  // ----------------------------------------------------------
  // Panel open / close
  // ----------------------------------------------------------
  function togglePanel() {
    const panel   = document.getElementById("a11y-panel");
    const trigger = document.getElementById("a11y-trigger");
    if (!panel) return;
    const isOpen = panel.classList.toggle("a11y-open");
    panel.hidden  = !isOpen;
    trigger.setAttribute("aria-expanded", isOpen);
    if (isOpen) {
      // Move focus into the panel
      setTimeout(() => {
        const first = panel.querySelector("button, input, [tabindex]");
        if (first) first.focus();
      }, 50);
    }
  }

  function closePanel() {
    const panel = document.getElementById("a11y-panel");
    if (!panel) return;
    panel.classList.remove("a11y-open");
    panel.hidden = true;
    const trigger = document.getElementById("a11y-trigger");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  // ----------------------------------------------------------
  // Respect OS-level prefers-reduced-motion
  // ----------------------------------------------------------
  function respectOsPrefs() {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches && !prefs.reduceMotion) {
      prefs.reduceMotion = true;
      savePrefs();
    }
  }

  // ----------------------------------------------------------
  // Boot
  // ----------------------------------------------------------
  function init() {
    loadPrefs();
    respectOsPrefs();
    applyPrefs();   // apply classes immediately (before toolbar builds) to avoid FOUC
    buildToolbar();
    applyPrefs();   // re-apply after toolbar is in DOM so syncPanelUI runs with real elements

    // Restore saved language preference (kicks off GT or routes to
    // translated page only if a non-English language was saved)
    if (prefs.language && prefs.language !== "en") {
      // Small delay so the page is interactive before GT loads
      setTimeout(() => applyLanguage(prefs.language), 500);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();