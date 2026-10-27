/*
 * Draws a status page from the uptime checker's daily tallies.
 *
 * The same file is used on ourmynd.com/status and chfrldn.com/status; each
 * page sets the checker URL, the services and their wording on the
 * [data-status] element, and styles the result with its own colours.
 *
 * Wide screens get 90 daily bars and narrow ones the last 30; both sets of
 * labels are rendered and CSS shows the right one, so nothing is redrawn on
 * resize.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-status]');
  if (!root) return;

  var API = root.getAttribute('data-api');
  // One service id, or several separated by spaces, drawn as one row each.
  var SERVICES = root.getAttribute('data-service').trim().split(/\s+/);
  var UP_TEXT = root.getAttribute('data-up-text') || 'All systems operational';
  var REFRESH_MS = 60 * 1000;
  // Checks run every 5 minutes. Three missed runs means the checker itself is
  // in trouble, and the page should not keep claiming the last answer.
  var STALE_MS = 20 * 60 * 1000;

  var dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  var monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // data-label-<id> names one service, data-label names a page's only one.
  function labelFor(data) {
    return root.getAttribute('data-label-' + data.id) || root.getAttribute('data-label') || data.name || 'Server';
  }

  function toDate(iso) { return new Date(iso + 'T00:00:00Z'); }

  function ago(ms) {
    var minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'just now';
    if (minutes === 1) return '1 minute ago';
    if (minutes < 60) return minutes + ' minutes ago';
    var hours = Math.round(minutes / 60);
    return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  }

  function percent(up, checks) {
    if (!checks) return null;
    var value = (up / checks) * 100;
    return value === 100 ? '100%' : value.toFixed(2).replace(/\.?0+$/, '') + '%';
  }

  function uptimeOver(days) {
    var up = 0, checks = 0;
    days.forEach(function (d) { up += d.up; checks += d.checks; });
    var p = percent(up, checks);
    return p ? p + ' uptime' : 'No data yet';
  }

  // A day the server spent idle (suspended on Render) has no checks,
  // only off ones, and is drawn yellow: idle, not down.
  function grade(day) {
    if (!day.checks) return day.off ? 'off' : 'empty';
    if (day.up === day.checks) return 'ok';
    return day.up / day.checks >= 0.9 ? 'partial' : 'major';
  }

  function duration(minutes) {
    if (minutes < 60) return minutes + ' minutes';
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return h + (h === 1 ? ' hour' : ' hours') + (m ? ' ' + m + ' min' : '');
  }

  function describe(day, interval) {
    var title = dayFmt.format(toDate(day.date));
    var off = (day.off || 0) * interval;
    if (!day.checks) return { title: title, lines: [off ? 'Idle' : 'No data recorded'] };
    var down = (day.checks - day.up) * interval;
    var lines = [down === 0 ? 'No downtime' : 'Down about ' + duration(down)];
    if (off) lines.push('Idle for about ' + duration(off));
    lines.push(percent(day.up, day.checks) + ' uptime from ' + day.checks + (day.checks === 1 ? ' check' : ' checks'));
    return { title: title, lines: lines };
  }

  /* -- Banner --------------------------------------------------------- */

  // A failed recent check outranks everything else; then a missing or stale
  // one. A server that is switched off (suspended on Render) is not a
  // failure: with a primary and a secondary only one runs at a time, so the
  // page is green while every server is either answering or switched off,
  // and at least one is answering.
  function banner(list) {
    var box = el('section', 'st-banner');
    var dot = el('span', 'st-dot');
    dot.setAttribute('aria-hidden', 'true');
    var text = el('div', 'st-banner-text');
    var head = el('strong', 'st-banner-head');
    var sub = el('p', 'st-banner-sub');
    var now = Date.now();
    function age(data) { return data.current ? now - Date.parse(data.current.at) : Infinity; }
    var fresh = list.filter(function (d) { return age(d) <= STALE_MS; });
    var down = fresh.filter(function (d) { return !d.current.ok && !d.current.suspended; });
    var off = fresh.filter(function (d) { return d.current.suspended; });
    var running = fresh.filter(function (d) { return d.current.ok; });
    var checked = list.filter(function (d) { return d.current; });

    if (down.length === 1) {
      var c = down[0].current;
      box.classList.add('is-down');
      head.textContent = labelFor(down[0]) + ' is not responding';
      sub.textContent = 'The last check, ' + ago(age(down[0])) + ', ' +
        (c.status ? 'got an error (HTTP ' + c.status + ').' : 'got no answer.');
    } else if (down.length) {
      box.classList.add('is-down');
      head.textContent = down.length + ' servers are not responding';
      sub.textContent = down.map(labelFor).join(' and ') + ' failed their last checks.';
    } else if (!checked.length) {
      box.classList.add('is-unknown');
      head.textContent = 'No checks yet';
      sub.textContent = 'The first check runs within five minutes of monitoring starting.';
    } else if (fresh.length < list.length) {
      box.classList.add('is-unknown');
      head.textContent = 'Status unknown';
      var oldest = Math.max.apply(null, checked.map(age));
      sub.textContent = oldest > STALE_MS
        ? 'The last check ran ' + ago(oldest) + ', so this may be out of date.'
        : 'A server was added recently and has not been checked yet.';
    } else if (!running.length) {
      box.classList.add('is-down');
      head.textContent = list.length === 1 ? labelFor(list[0]) + ' is not running' : 'No server is running';
      sub.textContent = 'The last ' + (list.length === 1 ? 'check' : 'checks') + ', ' +
        ago(Math.max.apply(null, list.map(age))) + ', found ' + (list.length === 1 ? 'it' : 'every server') + ' idle.';
    } else if (list.length === 1) {
      box.classList.add('is-ok');
      head.textContent = UP_TEXT;
      sub.textContent = labelFor(list[0]) + ' answered the last check, ' + ago(age(list[0])) + ', in ' +
        (list[0].current.ms / 1000).toFixed(1) + 's.';
    } else {
      box.classList.add('is-ok');
      head.textContent = UP_TEXT;
      var when = ago(Math.max.apply(null, running.map(age)));
      sub.textContent = off.length
        ? running.map(labelFor).join(' and ') + ' answered the last check, ' + when + '. ' +
          off.map(labelFor).join(' and ') + ' is idle.'
        : 'Every server answered its last check, ' + when + '.';
    }
    box.setAttribute('role', 'status');
    text.appendChild(head);
    text.appendChild(sub);
    box.appendChild(dot);
    box.appendChild(text);
    return box;
  }

  /* -- Bars ----------------------------------------------------------- */

  var tip = el('div', 'st-tip');
  tip.setAttribute('role', 'tooltip');
  tip.id = 'st-tip';
  tip.hidden = true;

  function showTip(bar) {
    var info = JSON.parse(bar.getAttribute('data-info'));
    tip.textContent = '';
    tip.appendChild(el('strong', null, info.title));
    info.lines.forEach(function (line) { tip.appendChild(el('span', null, line)); });
    tip.hidden = false;

    var r = bar.getBoundingClientRect();
    var t = tip.getBoundingClientRect();
    var left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    var top = r.top - t.height - 10;
    if (top < 8) top = r.bottom + 10;
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = top + window.scrollY + 'px';
    bars().forEach(function (b) { b.classList.toggle('is-active', b === bar); });
  }

  function hideTip() {
    tip.hidden = true;
    bars().forEach(function (b) { b.classList.remove('is-active'); });
  }

  function bars(scope) { return Array.prototype.slice.call((scope || root).querySelectorAll('.st-bar')); }

  function visibleBars(scope) {
    return bars(scope).filter(function (b) { return b.offsetParent !== null; });
  }

  function row(data) {
    var wrap = el('div', 'st-row');
    var head = el('div', 'st-row-head');
    var name = el('span', 'st-name');
    var nameDot = el('span', 'st-dot');
    nameDot.setAttribute('aria-hidden', 'true');
    var state = !data.current ? 'unknown' : data.current.ok ? 'ok' : data.current.suspended ? 'off' : 'down';
    name.classList.add('is-' + state);
    name.appendChild(nameDot);
    name.appendChild(document.createTextNode(labelFor(data)));

    var uptime = el('span', 'st-uptime');
    if (state === 'off') {
      uptime.textContent = 'Idle';
    } else {
      uptime.appendChild(el('span', 'st-long', uptimeOver(data.days)));
      uptime.appendChild(el('span', 'st-short', uptimeOver(data.days.slice(-30))));
    }
    head.appendChild(name);
    head.appendChild(uptime);

    var list = el('ol', 'st-bars');
    list.tabIndex = 0;
    list.setAttribute('aria-label', 'Daily uptime. Use the arrow keys to read each day.');
    list.setAttribute('aria-describedby', 'st-tip');
    data.days.forEach(function (day) {
      var info = describe(day, data.intervalMinutes || 5);
      var bar = el('li', 'st-bar is-' + grade(day));
      bar.setAttribute('data-info', JSON.stringify(info));
      bar.setAttribute('aria-label', info.title + ': ' + info.lines.join('. '));
      list.appendChild(bar);
    });

    // Pointer: hover on desktop, tap on touch screens.
    list.addEventListener('pointerover', function (e) {
      if (e.target.classList.contains('st-bar')) showTip(e.target);
    });
    list.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') hideTip();
    });
    // Keyboard: each list is one tab stop, the arrow keys walk its days.
    list.addEventListener('keydown', function (e) {
      var shown = visibleBars(list);
      if (!shown.length) return;
      var current = shown.indexOf(list.querySelector('.st-bar.is-active'));
      var next = current;
      if (e.key === 'ArrowLeft') next = current <= 0 ? 0 : current - 1;
      else if (e.key === 'ArrowRight') next = current < 0 ? shown.length - 1 : Math.min(shown.length - 1, current + 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = shown.length - 1;
      else if (e.key === 'Escape') { hideTip(); return; }
      else return;
      e.preventDefault();
      showTip(shown[next]);
    });
    // Tabbing in starts on today. A mouse click also focuses the list, but the
    // bar under the pointer is already showing, so leave it alone.
    list.addEventListener('focus', function () {
      if (list.querySelector('.st-bar.is-active')) return;
      var shown = visibleBars(list);
      if (shown.length) showTip(shown[shown.length - 1]);
    });
    list.addEventListener('blur', hideTip);

    var axis = el('div', 'st-axis');
    var start = el('span');
    start.appendChild(el('span', 'st-long', '90 days ago'));
    start.appendChild(el('span', 'st-short', '30 days ago'));
    axis.appendChild(start);
    axis.appendChild(el('span', null, 'Today'));

    wrap.appendChild(head);
    wrap.appendChild(list);
    wrap.appendChild(axis);
    return wrap;
  }

  function card(list) {
    var days = list[0].days;
    var box = el('section', 'st-card');
    var head = el('header', 'st-card-head');
    head.appendChild(el('h2', null, 'System status'));
    var first = toDate(days[0].date), firstShort = toDate(days[days.length - 30].date);
    var last = toDate(days[days.length - 1].date);
    var range = el('span', 'st-range');
    range.appendChild(el('span', 'st-long', monthFmt.format(first) + ' to ' + monthFmt.format(last)));
    range.appendChild(el('span', 'st-short', monthFmt.format(firstShort) + ' to ' + monthFmt.format(last)));
    head.appendChild(range);
    box.appendChild(head);
    list.forEach(function (data) { box.appendChild(row(data)); });
    return box;
  }

  /* -- Load ----------------------------------------------------------- */

  function render(list) {
    hideTip();
    root.textContent = '';
    root.setAttribute('aria-busy', 'false');
    root.appendChild(banner(list));
    root.appendChild(card(list));
  }

  function fail() {
    // Keep a good render on screen if a refresh fails; only replace the
    // loading state.
    if (root.querySelector('.st-card')) return;
    root.textContent = '';
    var box = el('section', 'st-banner is-unknown');
    var dot = el('span', 'st-dot');
    var text = el('div', 'st-banner-text');
    text.appendChild(el('strong', 'st-banner-head', 'Could not load the status'));
    text.appendChild(el('p', 'st-banner-sub', 'The status service did not answer. This page tries again every minute.'));
    box.appendChild(dot);
    box.appendChild(text);
    root.appendChild(box);
  }

  // One request per service, drawn together once all have answered.
  function load() {
    var base = API.replace(/\/+$/, '') + '/api/status?service=';
    Promise.all(SERVICES.map(function (id) {
      return fetch(base + encodeURIComponent(id), { cache: 'no-store' })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); });
    }))
      .then(render)
      .catch(fail);
  }

  document.body.appendChild(tip);
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.classList || !e.target.classList.contains('st-bar')) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });
  load();
  setInterval(load, REFRESH_MS);
})();
