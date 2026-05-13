// =====================================
// VOLUNTEER FORM SCRIPT
// =====================================
// Handles dropdowns, Turnstile integration, and form submission for volunteer sign-up forms.
// Designed to be reusable across multiple forms
// Note: This script assumes a certain HTML structure for the forms. Make sure to follow the
// expected structure for dropdowns and form fields for it to work correctly.
//
// Expected HTML structure for dropdowns:
//
// ~~~~~~~~ Interests Dropdown ~~~~~~~~
// <div class="interest-dropdown">
//   <button type="button" class="interest-dropdown-btn">
//     <span class="interest-btn-text">Select interests</span>
//   </button>
//   <div class="interest-dropdown-menu">
//
// ~~~~~~~~ Languages Dropdown ~~~~~~~~
// <div class="language-dropdown">
//   <button type="button" class="language-dropdown-btn">
//     <span class="language-btn-text">Select languages</span>
//   </button>
//   <div class="language-dropdown-menu">

// ====================================
// CONFIG
// ====================================

const TURNSTILE_SITE_KEY = "0x4AAAAAADGm0uPo8ej66jcz";
const API_BASE = "/api";

// ====================================
// Centralized language list
// ====================================

const OUTREACH_LANGUAGES = [
	"Albanian",
	"Amharic",
	"Arabic",
	"Armenian",
	"Belarusian",
	"Bulgarian",
	"Bengali",
	"Cantonese",
	"Croatian",
	"Czech",
	"Danish",
	"Dutch",
	"Estonian",
	"Finnish",
	"French",
	"German",
	"Greek",
	"Gujarati",
	"Hebrew",
	"Hindi",
	"Hungarian",
	"Icelandic",
	"Indonesian",
	"Italian",
	"Japanese",
	"Khmer",
	"Korean",
	"Kurdish",
	"Latvian",
	"Lao",
	"Lithuanian",
	"Luxembourgish",
	"Macedonian",
	"Malay",
	"Maltese",
	"Mandarin",
	"Norwegian",
  "Polish",
	"Portuguese",
	"Punjabi",
	"Romanian",
  "Russian",
  "Serbian",
	"Slovak",
	"Slovenian",
	"Somali",
	"Spanish",
	"Swedish",
	"Swahili",
  "Tagalog",
	"Tamil",
	"Thai",
	"Turkish",
	"Ukrainian",
	"Urdu",
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
	"PNG (Papua New Guinea Sign Language)"
];

const VOLUNTEER_INTERESTS = [
  "Phone banking",
  "Text banking",
  "Canvassing / Door knocking",
  "Events",
  "Social media",
	"I'm not sure yet",
];

// =====================================================
// DROPDOWN BUILDER
// =====================================================

function buildCheckboxDropdown(config) {
  const {
    form,
    rootSelector,
    btnSelector,
    menuSelector,
    btnTextSelector,
    name,
    options,
    placeholder,
    includeOther = false,
    otherInputName = "other"
  } = config;

  const root = form.querySelector(rootSelector);
  if (!root) return;

  const btn = root.querySelector(btnSelector);
  const menu = root.querySelector(menuSelector);
  const btnText = root.querySelector(btnTextSelector);

  if (!btn || !menu || !btnText) return;

  menu.innerHTML = "";

  function makeOption(value) {
    const label = document.createElement("label");
    label.className = "dropdown-option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.value = value;

    const text = document.createElement("span");
    text.className = "opt-text";
    text.textContent = value;

    label.append(input, text);
    return label;
  }

  options.forEach(opt => menu.appendChild(makeOption(opt)));

  let otherInput = null;
  let otherCheckbox = null;

  if (includeOther) {
    const divider = document.createElement("div");
    divider.className = "dropdown-divider";
    menu.appendChild(divider);

    const otherLabel = makeOption("Other");
    menu.appendChild(otherLabel);

    otherCheckbox = otherLabel.querySelector("input");

    otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.name = otherInputName;
    otherInput.placeholder = "If other, please specify";
    otherInput.maxLength = 60;
    otherInput.style.display = "none";
    otherInput.style.marginTop = "8px";

    menu.appendChild(otherInput);
  }

  function updateLabel() {
    const selected = Array.from(
      menu.querySelectorAll(`input[name="${name}"]:checked`)
    ).map(cb => cb.value);

    if (selected.length === 0) {
      btnText.textContent = placeholder;
    } else if (selected.length <= 2) {
      btnText.textContent = selected.join(", ");
    } else {
      btnText.textContent = `${selected.length} selected`;
    }
  }

  btn.addEventListener("click", e => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  menu.addEventListener("click", e => {
    e.stopPropagation();
    const label = e.target.closest(".dropdown-option");
    if (!label) return;

    const cb = label.querySelector("input");
    cb.checked = !cb.checked;

  	if (cb.checked) {
    	label.classList.add("is-selected");
  	} else {
    	label.classList.remove("is-selected");
  	}

    if (otherCheckbox && cb === otherCheckbox) {
      otherInput.style.display = cb.checked ? "block" : "none";
      if (!cb.checked) otherInput.value = "";
    }

    updateLabel();
  });

  document.addEventListener("click", () => menu.classList.remove("open"));

  updateLabel();
}

// =====================================================
// TURNSTILE HANDLER
// =====================================================

function waitForTurnstile(maxWait = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      if (typeof turnstile !== "undefined") {
        resolve(turnstile);
      } else if (Date.now() - start > maxWait) {
        reject(new Error("Turnstile failed to load within timeout."));
      } else {
        requestAnimationFrame(check);
      }
    }

    check();
  });
}

function setupTurnstile(form) {
  let widgetId = null;

  const container = form.querySelector(".turnstile-container");
  if (!container) return null;

  return async function executeTurnstile(callback) {
    container.style.display = "block";

    try {
      await waitForTurnstile();

      if (widgetId !== null) {
        turnstile.reset(widgetId);
        turnstile.execute(widgetId);
        return;
      }

      widgetId = turnstile.render(container, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: token => callback(token)
      });

    } catch (err) {
      console.error(err);
      alert("Security verification failed to load. Please refresh.");
    }
  };
}

// =====================================================
// API SUBMISSION
// =====================================================

async function submitVolunteer(payload) {
  const res = await fetch(`${API_BASE}/volunteer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

	if (!res.ok) {
		console.error("API Error:", data);
		throw new Error(data.error || "Submission failed");
	}

	return data;
}

// =====================================================
// SUCCESS & ERROR HANDLING
// =====================================================

function showMessage(form, message, isError = false) {
  let box = form.querySelector(".form-message");

  if (!box) {
    box = document.createElement("div");
    box.className = "form-message";
    box.style.marginTop = "1rem";
    box.style.fontWeight = "600";
    form.appendChild(box);
  }

  box.textContent = message;
  box.style.color = isError ? "#b00020" : "#0a7a3d";
}

function showHomepagePortalSuccess(form) {
	const portal = document.querySelector(".home-join-cloud");
	const header = portal.querySelector(".home-join-cloud-inner h2");

	// Fade out form
	form.style.transition = "opacity 0.4s ease";
	form.style.opacity = "0";
	setTimeout(() => {form.style.display = "none";}, 400);

	// Intensify portal glow briefly
	portal.classList.add("portal-success-glow");

	// Update header text
	header.textContent = "Welcome to the Movement ✨";

	// Create centered message
	const successMessage = document.createElement("div");
	successMessage.className = "portal-success-message";
	successMessage.innerHTML = `
		<p>You’re almost in — check your inbox to confirm your email and complete your sign-up.</p>
		<p style="font-size:0.9rem;opacity:0.8;">The confirmation link expires in 24 hours. Check your spam if you don’t see it.</p>
		<p style="margin-top:0.75rem;">In the meantime, help someone else through the portal.</p>

		<button class="portal-share-btn">
			Bring Someone Through
		</button>

		<div class="portal-share-links">
			<a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}" target="_blank">
				<i class="fab fa-facebook"></i>
			</a>

			<a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(window.location.href)}&text=${encodeURIComponent("Join me in supporting Alexandria for IL-10 ✨")}" target="_blank">
				<i class="fab fa-twitter"></i>
			</a>

			<a href="https://www.instagram.com/" target="_blank">
				<i class="fab fa-instagram"></i>
			</a>
		</div>
	`;
	portal.appendChild(successMessage);

	setTimeout(() => {successMessage.style.opacity = "1";}, 50);
}

function showSuccessState(form) {
	const isHomepage = form.id === "homepage-join-form";

	if (isHomepage) {
		showHomepagePortalSuccess(form);
		return;
	}

	// Default behavior for all other forms
	// Hide all direct children except existing message
	const children = Array.from(form.children);

	children.forEach(child => {
		if (!child.classList.contains("form-message")) {
			child.style.transition = "opacity 0.4s ease";
			child.style.opacity = "0";
			setTimeout(() => {child.style.display = "none";}, 400);
		}
	});

	// Create success container
	const successBox = document.createElement("div");
	successBox.className ="form-success-state";
	successBox.innerHTML = `
		<div class="success-icon">✉️</div>
		<h2>Almost there — check your inbox!</h2>
		<p>We've sent a confirmation email to the address you provided.</p>
		<p>Please click the link in that email to complete your sign-up. The link will expire in <strong>24 hours</strong>.</p>
		<p style="margin-top:0.75rem;font-size:0.9rem;color:var(--muted);">Don't see it? Check your spam or junk folder.</p>
	`;
	form.appendChild(successBox);

	// Animate in success state
	setTimeout(() => {
		successBox.style.opacity = "1";
	}, 50);
}

// =====================================================
// MAIN INITIALIZER
// =====================================================

document.addEventListener("DOMContentLoaded", () => {

  const forms = document.querySelectorAll(
    ".volunteer-form, [data-volunteer-form]"
  );

  forms.forEach(form => {

		let hasSubmitted = false; // Flag to prevent multiple submissions
		const submitBtn = form.querySelector('button[type="submit"]');

    // 🔹 Detect if this form has dropdown sections
    const hasInterestDropdown = form.querySelector(".interest-dropdown");
    const hasLanguageDropdown = form.querySelector(".language-dropdown");

    // 🔹 Only build dropdowns if they exist
    if (hasLanguageDropdown) {
      buildCheckboxDropdown({
        form,
        rootSelector: ".language-dropdown",
        btnSelector: ".language-dropdown-btn",
        menuSelector: ".language-dropdown-menu",
        btnTextSelector: ".language-btn-text",
        name: "languages[]",
        options: OUTREACH_LANGUAGES,
        placeholder: "Select languages",
        includeOther: true,
        otherInputName: "language_other"
      });
    }

    if (hasInterestDropdown) {
      buildCheckboxDropdown({
        form,
        rootSelector: ".interest-dropdown",
        btnSelector: ".interest-dropdown-btn",
        menuSelector: ".interest-dropdown-menu",
        btnTextSelector: ".interest-btn-text",
        name: "interests[]",
        options: VOLUNTEER_INTERESTS,
        placeholder: "Select interests",
        includeOther: true,
        otherInputName: "interest_other"
      });
    }

    const runTurnstile = setupTurnstile(form);

    form.addEventListener("submit", e => {
      e.preventDefault();

			if (hasSubmitted) return; // Prevent multiple submissions
 
      let interests = [];
      let languages = [];

      // 🔹 Only validate interests if dropdown exists
      if (hasInterestDropdown) {
        interests = Array.from(
          form.querySelectorAll('input[name="interests[]"]:checked')
        ).map(i => i.value);

        if (interests.length === 0) {
          showMessage(form, "Please select at least one volunteer activity.", true);
          return;
        }
      }

      if (hasLanguageDropdown) {
        languages = Array.from(
          form.querySelectorAll('input[name="languages[]"]:checked')
        ).map(i => i.value);
      }

      const payload = {
        name: form.querySelector("#name")?.value.trim(),
        email: form.querySelector("#email")?.value.trim(),
        phone: form.querySelector("#phone")?.value.trim(),
        zip: form.querySelector("#zip")?.value.trim(),
        interests,
        languages,
        consent: form.querySelector("#consent")?.checked || false,
        form_type: form.dataset.formType || "volunteer_page"
      };

      runTurnstile(async token => {
				if (hasSubmitted) return; // Double-check flag inside async callback

        try {
					hasSubmitted = true; // Set flag to prevent further submissions

          payload.turnstileToken = token;
          await submitVolunteer(payload);

          showSuccessState(form);

        } catch (err) {
          showMessage(form, "There was an issue submitting the form.", true);
					console.error(err);
					hasSubmitted = false; // Reset flag to allow retry
					if (submitBtn) submitBtn.disabled = false; // Re-enable submit button if it was disabled
        }
      });
    });
  });
});