(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Nav scroll state ---------- */
  var nav = document.getElementById("siteNav");
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle("is-scrolled", window.scrollY > 12);
  }
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile menu ---------- */
  var navToggle = document.getElementById("navToggle");
  var mobileMenu = document.getElementById("mobileMenu");
  if (navToggle && mobileMenu) {
    var closeMenu = function () {
      navToggle.setAttribute("aria-expanded", "false");
      mobileMenu.classList.remove("is-open");
      mobileMenu.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    };
    var openMenu = function () {
      navToggle.setAttribute("aria-expanded", "true");
      mobileMenu.classList.add("is-open");
      mobileMenu.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    };
    navToggle.addEventListener("click", function () {
      var isOpen = mobileMenu.classList.contains("is-open");
      isOpen ? closeMenu() : openMenu();
    });
    mobileMenu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });
  }

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { observer.observe(el); });
  }

  /* ---------- Hero parallax ---------- */
  var heroMedia = document.getElementById("heroMedia");
  if (heroMedia && !reduceMotion) {
    var ticking = false;
    var updateParallax = function () {
      var offset = Math.min(window.scrollY * 0.18, 120);
      heroMedia.style.transform = "translateY(" + offset + "px) scale(1.02)";
      ticking = false;
    };
    document.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          requestAnimationFrame(updateParallax);
          ticking = true;
        }
      },
      { passive: true }
    );
  }

  /* ---------- Journey type -> flight number visibility ---------- */
  var journeyType = document.getElementById("journeyType");
  var flightField = document.getElementById("flightField");
  function syncFlightField() {
    if (!journeyType || !flightField) return;
    var needsFlight = journeyType.value === "AIRPORT_TRANSFER" || journeyType.value === "PRIVATE_AVIATION";
    flightField.classList.toggle("is-hidden", !needsFlight);
  }
  if (journeyType) {
    journeyType.addEventListener("change", syncFlightField);
    syncFlightField();
  }

  /* ---------- Corporate / preset CTAs ---------- */
  document.querySelectorAll("[data-preset-journey]").forEach(function (el) {
    el.addEventListener("click", function () {
      var value = el.getAttribute("data-preset-journey");
      if (journeyType) {
        journeyType.value = value;
        syncFlightField();
      }
      var bookSection = document.getElementById("book");
      if (bookSection) bookSection.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    });
  });

  /* ---------- Booking form -> POST /api/bookings ---------- */
  var form = document.getElementById("bookingForm");
  if (form) {
    var successEl = document.getElementById("formSuccess");
    var errorEl = document.getElementById("formError");
    var referenceEl = document.getElementById("bookingReference");
    var submitBtn = form.querySelector('button[type="submit"]');
    var originalLabel = submitBtn ? submitBtn.textContent : "Request Chauffeur";

    /* Stable for the life of one filled-in form, so a double tap or a retry
       after a flaky connection cannot create a second booking. */
    function newKey() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      return "k-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }
    var idempotencyKey = newKey();

    function clearFieldErrors() {
      form.querySelectorAll("[aria-invalid]").forEach(function (el) {
        el.removeAttribute("aria-invalid");
      });
      form.querySelectorAll(".field-error").forEach(function (el) {
        el.parentNode.removeChild(el);
      });
    }

    function showFieldErrors(fields) {
      clearFieldErrors();
      var first = null;
      fields.forEach(function (issue) {
        var input = form.querySelector('[name="' + issue.field + '"]');
        if (!input) return;
        input.setAttribute("aria-invalid", "true");
        var msg = document.createElement("span");
        msg.className = "field-error";
        msg.textContent = issue.message;
        (input.parentNode || form).appendChild(msg);
        if (!first) first = input;
      });
      if (first) {
        first.focus();
        first.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      }
    }

    function setBusy(busy) {
      if (!submitBtn) return;
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? "Sending..." : originalLabel;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearFieldErrors();
      if (errorEl) errorEl.hidden = true;

      /* The browser's own validation is a convenience; the server is the authority. */
      if (typeof form.checkValidity === "function" && !form.checkValidity()) {
        form.reportValidity();
        return;
      }

      setBusy(true);

      var payload = {};
      new FormData(form).forEach(function (value, key) {
        var v = typeof value === "string" ? value.trim() : value;
        /* Empty optional fields are omitted so the server's defaults apply. */
        if (v !== "") payload[key] = v;
      });
      payload.idempotency_key = idempotencyKey;

      fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().then(
            function (body) { return body; },
            function () { return {}; }
          );
        })
        .then(function (body) {
          var data = body && body.data;
          if (body && body.ok && data && data.booking_reference) {
            if (referenceEl) referenceEl.textContent = data.booking_reference;
            form.reset();
            form.classList.add("is-submitted");
            if (successEl) {
              successEl.hidden = false;
              successEl.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            }
            /* A genuinely new enquiry after this one must not be deduplicated. */
            idempotencyKey = newKey();
            return;
          }

          var error = (body && body.error) || {};
          if (error.fields && error.fields.length) {
            showFieldErrors(error.fields);
          } else if (errorEl) {
            errorEl.hidden = false;
          }
          setBusy(false);
        })
        .catch(function () {
          /* Network failure. The customer sees plain language, never a stack trace. */
          if (errorEl) errorEl.hidden = false;
          setBusy(false);
        });
    });
  }
})();
