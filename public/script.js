/* CHFR LDN — booking form.
   Submits to the CHFR booking API, shows a booking reference on success, and
   never exposes a technical error to the customer. */
(function () {
  'use strict';

  var form = document.getElementById('bookingForm');
  if (!form) return;

  var submit = document.getElementById('bookingSubmit');
  var alertBox = document.getElementById('formError');
  var success = document.getElementById('bookingSuccess');
  var refOut = document.getElementById('bookingRef');
  var again = document.getElementById('bookingAnother');
  var submitting = false;

  /* One key per filled-in form. If the customer double-clicks, the network
     retries, or the page is re-posted, the server returns the original booking
     instead of creating a second one. */
  function newKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
  }
  var idempotencyKey = newKey();

  /* Nothing earlier than today can be requested. */
  var dateInput = form.querySelector('input[name="journey_date"]');
  if (dateInput) {
    var now = new Date();
    dateInput.min = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }

  /* Keep the selects in step with the server's reference data, so a vehicle or
     journey type added in the dashboard appears here without a redeploy. */
  fetch('/api/booking-options', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (payload) {
      if (!payload || !payload.ok) return;
      var data = payload.data;
      Array.prototype.forEach.call(form.querySelectorAll('[data-options]'), function (select) {
        var list = data[select.getAttribute('data-options')];
        if (!list || !list.length) return;
        var previous = select.value;
        select.innerHTML = '';
        list.forEach(function (item) {
          var opt = document.createElement('option');
          opt.value = item.value;
          opt.textContent = item.label;
          select.appendChild(opt);
        });
        if (previous) select.value = previous;
      });
      if (data.turnstileSiteKey) mountTurnstile(data.turnstileSiteKey);
    })
    .catch(function () { /* the hard-coded options in the HTML remain valid */ });

  function mountTurnstile(siteKey) {
    var mount = document.getElementById('turnstileMount');
    if (!mount || mount.dataset.mounted) return;
    mount.dataset.mounted = '1';
    var widget = document.createElement('div');
    widget.className = 'cf-turnstile';
    widget.setAttribute('data-sitekey', siteKey);
    widget.setAttribute('data-theme', 'dark');
    mount.appendChild(widget);
    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  function clearErrors() {
    alertBox.hidden = true;
    alertBox.textContent = '';
    Array.prototype.forEach.call(form.querySelectorAll('.field-error'), function (el) {
      el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) {
      el.removeAttribute('aria-invalid');
    });
  }

  function showFieldErrors(issues) {
    var firstField = null;
    issues.forEach(function (issue) {
      var field = form.querySelector('[name="' + issue.field + '"]');
      if (!field) return;
      field.setAttribute('aria-invalid', 'true');
      var note = document.createElement('span');
      note.className = 'field-error';
      note.textContent = issue.message;
      field.parentNode.appendChild(note);
      if (!firstField) firstField = field;
    });

    if (firstField) {
      firstField.focus();
      firstField.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      showAlert('Please check the details entered and try again.');
    }
  }

  function showAlert(message) {
    alertBox.textContent = message;
    alertBox.hidden = false;
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setBusy(busy) {
    submitting = busy;
    submit.disabled = busy;
    submit.textContent = busy ? 'Sending…' : 'Request a quote';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitting) return;
    clearErrors();

    /* Let the browser surface its own messages for obviously empty fields
       before we go near the network. */
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = typeof value === 'string' ? value.trim() : value;
    });
    data.idempotency_key = idempotencyKey;

    var turnstileField = form.querySelector('[name="cf-turnstile-response"]');
    if (turnstileField) {
      data.turnstile_token = turnstileField.value;
      delete data['cf-turnstile-response'];
    }
    if (data.passengers) data.passengers = String(data.passengers);

    setBusy(true);

    fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(data),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        var body = result.body || {};

        if (body.ok && body.data && body.data.booking_reference) {
          refOut.textContent = body.data.booking_reference;
          form.hidden = true;
          success.hidden = false;
          success.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }

        var error = body.error || {};
        if (error.fields && error.fields.length) {
          showFieldErrors(error.fields);
        } else {
          showAlert(
            error.message ||
              'Something went wrong sending your request. Please try again — or message us on ' +
              'Instagram @chfrldn and we will arrange your journey from there.'
          );
        }
        setBusy(false);
      })
      .catch(function () {
        /* Network or parsing failure — the customer sees plain language only. */
        showAlert(
          'We could not reach CHFR just now. Please check your connection and try again — ' +
          'or message us on Instagram @chfrldn and we will arrange your journey from there.'
        );
        setBusy(false);
      });
  });

  if (again) {
    again.addEventListener('click', function () {
      form.reset();
      idempotencyKey = newKey();
      clearErrors();
      setBusy(false);
      success.hidden = true;
      form.hidden = false;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
})();
