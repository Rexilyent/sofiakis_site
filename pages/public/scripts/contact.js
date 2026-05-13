/* ===========================
   CONTACT FORM
   =========================== */

(function () {
  'use strict';

  const CHAR_LIMIT      = 1000;
  const NEAR_LIMIT      = 850;
  let   turnstileWidget = null;
  let   turnstileToken  = null;

  // ---- DOM refs ----
  const form        = document.getElementById('contact-form');
  const nameInput   = document.getElementById('contact-name');
  const emailInput  = document.getElementById('contact-email');
  const subjectSel  = document.getElementById('contact-subject');
  const messageArea = document.getElementById('contact-message');
  const charCount   = document.getElementById('contact-char-count');
  const submitBtn   = document.getElementById('contact-submit-btn');
  const successDiv  = document.getElementById('contact-success');

  if (!form) return;

  // ---- Character counter ----
  messageArea.addEventListener('input', () => {
    const len = messageArea.value.length;
    charCount.textContent = `${len} / ${CHAR_LIMIT}`;
    charCount.classList.toggle('near-limit', len >= NEAR_LIMIT && len < CHAR_LIMIT);
    charCount.classList.toggle('at-limit',   len >= CHAR_LIMIT);
  });

  // ---- Turnstile init ----
  function initTurnstile() {
    if (typeof turnstile === 'undefined') return;
    const container = document.getElementById('contact-turnstile');
    if (!container || turnstileWidget !== null) return;

    turnstileWidget = turnstile.render(container, {
      sitekey: '0x4AAAAAADGm0uPo8ej66jcz',   // ← replace with your actual site key
      callback: (token) => { turnstileToken = token; },
      'expired-callback': () => { turnstileToken = null; },
      'error-callback':   () => { turnstileToken = null; },
    });
  }

  // Turnstile loads async — wait for it
  if (typeof turnstile !== 'undefined') {
    initTurnstile();
  } else {
    window.addEventListener('load', initTurnstile);
  }

  // ---- Validation helpers ----
  function setError(input, errorId, message) {
    const el = document.getElementById(errorId);
    if (!el) return;
    el.textContent = message;
    input.classList.toggle('invalid', !!message);
  }

  function clearError(input, errorId) {
    setError(input, errorId, '');
  }

  function validateName() {
    const val = nameInput.value.trim();
    if (!val) {
      setError(nameInput, 'contact-name-error', 'Please enter your full name.');
      return false;
    }
    clearError(nameInput, 'contact-name-error');
    return true;
  }

  function validateEmail() {
    const val = emailInput.value.trim();
    const re  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!val) {
      setError(emailInput, 'contact-email-error', 'Please enter your email address.');
      return false;
    }
    if (!re.test(val)) {
      setError(emailInput, 'contact-email-error', 'Please enter a valid email address.');
      return false;
    }
    clearError(emailInput, 'contact-email-error');
    return true;
  }

  function validateSubject() {
    if (!subjectSel.value) {
      setError(subjectSel, 'contact-subject-error', 'Please select a subject.');
      subjectSel.classList.add('invalid');
      return false;
    }
    setError(subjectSel, 'contact-subject-error', '');
    subjectSel.classList.remove('invalid');
    return true;
  }

  function validateMessage() {
    const val = messageArea.value.trim();
    if (!val) {
      setError(messageArea, 'contact-message-error', 'Please enter a message.');
      return false;
    }
    if (val.length > CHAR_LIMIT) {
      setError(messageArea, 'contact-message-error', `Message must be ${CHAR_LIMIT} characters or fewer.`);
      return false;
    }
    clearError(messageArea, 'contact-message-error');
    return true;
  }

  // Inline validation on blur
  nameInput.addEventListener('blur',    validateName);
  emailInput.addEventListener('blur',   validateEmail);
  subjectSel.addEventListener('change', validateSubject);
  messageArea.addEventListener('blur',  validateMessage);

  // ---- Form submit ----
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const valid = [validateName(), validateEmail(), validateSubject(), validateMessage()]
      .every(Boolean);

    if (!valid) return;

    submitBtn.disabled = true;
    submitBtn.querySelector('.btn-label').textContent = 'Sending…';

    try {
      const payload = {
        name:    nameInput.value.trim(),
        email:   emailInput.value.trim(),
        subject: subjectSel.value,
        message: messageArea.value.trim(),
        token:   turnstileToken,
      };

      // POST to your backend / Cloudflare Worker endpoint
      const res = await fetch('/api/contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`Server responded with ${res.status}`);

      // Show success
      form.querySelectorAll('.contact-field, .contact-form-row, .contact-actions, .turnstile-container')
        .forEach(el => { el.style.display = 'none'; });

      successDiv.hidden = false;

    } catch (err) {
      console.error('Contact form error:', err);
      submitBtn.disabled = false;
      submitBtn.querySelector('.btn-label').textContent = 'Send Message';

      // Reset Turnstile so a fresh token can be obtained
      if (turnstileWidget !== null && typeof turnstile !== 'undefined') {
        turnstile.reset(turnstileWidget);
        turnstileToken = null;
      }

      // Show a generic error beneath the submit button
      let errEl = document.getElementById('contact-submit-error');
      if (!errEl) {
        errEl = document.createElement('p');
        errEl.id = 'contact-submit-error';
        errEl.setAttribute('role', 'alert');
        errEl.style.cssText = 'color:#b00020;font-size:0.9rem;margin-top:0.5rem;text-align:right;';
        submitBtn.parentNode.insertAdjacentElement('afterend', errEl);
      }
      errEl.textContent = 'Something went wrong. Please try again or reach out on social media.';
    }
  });

})();