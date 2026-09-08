/* CHFR operations dashboard — small progressive enhancements only.
   Every page works without this file; it just makes the common actions nicer. */
(function () {
  'use strict';

  // Copy-to-clipboard buttons on the booking detail page.
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-copy]');
    if (!el) return;
    e.preventDefault();
    var text = el.getAttribute('data-copy');
    var restore = el.textContent;
    var done = function () {
      el.textContent = 'Copied';
      setTimeout(function () { el.textContent = restore; }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
      document.body.removeChild(ta); done();
    }
  });

  // Confirmation on destructive or outbound actions.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      e.preventDefault();
      return;
    }
    var submit = form.querySelector('button[type="submit"]');
    if (submit && !form.hasAttribute('data-no-lock')) {
      // Guard against a double-click creating two requests.
      setTimeout(function () {
        submit.disabled = true;
        submit.dataset.was = submit.textContent;
        submit.textContent = 'Working…';
      }, 0);
    }
  });

  // Submit filter forms when a select changes, so filtering is one click.
  var filterForm = document.querySelector('[data-autosubmit]');
  if (filterForm) {
    filterForm.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT') filterForm.submit();
    });
  }
})();
