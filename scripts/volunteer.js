// Centralized language list (edit here only)
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

function buildCheckboxDropdown({
  rootId,
  btnId,
  menuId,
  btnTextId,
  name,
  options,
  placeholder,
  includeOther = false,
  otherValue = "Other",
  otherInputName = "other",
  // NEW: optional hook called whenever selection changes
  onChange = null
}) {
  const root = document.getElementById(rootId);
  if (!root) return;

  const btn = document.getElementById(btnId);
  const btnText = document.getElementById(btnTextId);
  const menu = document.getElementById(menuId);

  if (!btn || !btnText || !menu) return;

  // --- Build menu items ---
  menu.innerHTML = "";

  function makeOption(value) {
    const label = document.createElement("label");
    label.className = "dropdown-option";
    label.setAttribute("data-value", value);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.value = value;

    // Keep checkbox accessible but hidden by CSS
    label.appendChild(input);

    const textNode = document.createElement("span");
    textNode.className = "opt-text";
    textNode.textContent = value;
    label.appendChild(textNode);

    return label;
  }

  options.forEach((opt) => menu.appendChild(makeOption(opt)));

  let otherCheckbox = null;
  let otherWrap = null;
  let otherInput = null;

  if (includeOther) {
    const divider = document.createElement("div");
    divider.className = "dropdown-divider";
    menu.appendChild(divider);

    const otherLabel = makeOption(otherValue);
    menu.appendChild(otherLabel);

    otherCheckbox = otherLabel.querySelector('input[type="checkbox"]');

    otherWrap = document.createElement("div");
    otherWrap.style.display = "none";
    otherWrap.style.paddingTop = "8px";

    otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.name = otherInputName;
    otherInput.placeholder = "If other, please specify";
    otherInput.maxLength = 60;

    // Match your form styles
    otherInput.style.width = "100%";
    otherInput.style.padding = "0.7rem 0.9rem";
    otherInput.style.borderRadius = "12px";
    otherInput.style.border = "1px solid rgba(0,0,0,0.12)";
    otherInput.style.background = "rgba(255,255,255,0.9)";
    otherInput.style.font = "inherit";

    otherWrap.appendChild(otherInput);
    menu.appendChild(otherWrap);
  }

  const getCheckboxes = () =>
    Array.from(menu.querySelectorAll(`input[type="checkbox"][name="${name}"]`));

  function setOpen(open) {
    menu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncSelectedStyles() {
    menu.querySelectorAll(".dropdown-option").forEach((label) => {
      const cb = label.querySelector('input[type="checkbox"]');
      label.classList.toggle("is-selected", !!cb?.checked);
    });
  }

  function updateButtonLabel() {
    const selected = getCheckboxes()
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);

    if (selected.length === 0) {
      btnText.textContent = placeholder;
    } else if (selected.length <= 2) {
      btnText.textContent = selected.join(", ");
    } else {
      btnText.textContent = `${selected.length} selected`;
    }
  }

  function updateOtherVisibility() {
    if (!includeOther || !otherCheckbox || !otherWrap) return;
    otherWrap.style.display = otherCheckbox.checked ? "block" : "none";
    if (!otherCheckbox.checked && otherInput) otherInput.value = "";
  }

  function notifyChange() {
    if (typeof onChange === "function") {
      onChange(getCheckboxes());
    }
  }

  // --- Button open/close ---
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // prevent document click from instantly closing
    setOpen(!menu.classList.contains("open"));
  });

  // --- Option selection: event delegation ---
  menu.addEventListener("click", (e) => {
    e.stopPropagation();

    const option = e.target.closest(".dropdown-option");
    if (!option) return;

    const cb = option.querySelector('input[type="checkbox"]');
    if (!cb) return;

    cb.checked = !cb.checked;

    syncSelectedStyles();
    updateButtonLabel();
    updateOtherVisibility();
    notifyChange();
  });

  // Close when clicking outside
  document.addEventListener("click", () => setOpen(false));

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  // Initialize
  syncSelectedStyles();
  updateButtonLabel();
  updateOtherVisibility();
  notifyChange();
}

document.addEventListener("DOMContentLoaded", () => {
  // ----- Languages dropdown -----
  buildCheckboxDropdown({
    rootId: "language-dropdown",
    btnId: "language-dropdown-btn",
    btnTextId: "language-btn-text",
    menuId: "language-dropdown-menu",
    name: "languages[]",
    options: OUTREACH_LANGUAGES,
    placeholder: "Select languages",
    includeOther: true,
    otherValue: "Other",
    otherInputName: "language_other"
  });

  // ----- Interests dropdown (REQUIRED) -----
  const form = document.querySelector(".volunteer-form");
  const interestError = document.getElementById("interest-error");
  const interestBtn = document.getElementById("interest-dropdown-btn");

  function setInterestError(message) {
    if (!interestError || !interestBtn) return;

    if (message) {
      interestError.textContent = message;
      interestError.classList.add("active");
      interestBtn.classList.add("invalid");
    } else {
      interestError.textContent = "";
      interestError.classList.remove("active");
      interestBtn.classList.remove("invalid");
    }
  }

  buildCheckboxDropdown({
    rootId: "interest-dropdown",
    btnId: "interest-dropdown-btn",
    btnTextId: "interest-btn-text",
    menuId: "interest-dropdown-menu",
    name: "interests[]",
    options: VOLUNTEER_INTERESTS,
    placeholder: "Select interests",
    includeOther: true,
    otherValue: "Other",
    otherInputName: "interest_other",

    // Clear error as soon as user selects something
    onChange: (checkboxes) => {
      const selectedCount = checkboxes.filter(cb => cb.checked).length;
      if (selectedCount > 0) setInterestError("");
    }
  });

  // Enforce required on submit
  if (form) {
    form.addEventListener("submit", (e) => {
      const selected = form.querySelectorAll('input[name="interests[]"]:checked');
      if (selected.length === 0) {
        e.preventDefault();
        setInterestError("Please select at least one volunteer activity.");
        if (interestBtn) interestBtn.focus();
      } else {
        setInterestError("");
      }
    });
  }
});