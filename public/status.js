/*
 * Draws a status page from the uptime checker's daily tallies.
 *
 * The same file is used on ourmynd.com/status and chfrldn.com/status; each
 * page sets the checker URL, the service and its wording on the [data-status]
 * element, and styles the result with its own colours.
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
  var SERVICE = root.getAttribute('data-service');
  var LABEL = root.getAttribute('data-label') || 'Server';
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

  function grade(day) {
    if (!day.checks) return 'empty';
    if (day.up === day.checks) return 'ok';
    return day.up / day.checks >= 0.9 ? 'partial' : 'major';
  }

  function describe(day, interval) {
    if (!day.checks) return { title: dayFmt.format(toDate(day.date)), lines: ['No data recorded'] };
    var down = (day.checks - day.up) * interval;
    var line;
    if (down === 0) line = 'No downtime';
    else if (down < 60) line = 'Down about ' + down + ' minutes';
    else {
      var h = Math.floor(down / 60), m = down % 60;
      line = 'Down about ' + h + (h === 1 ? ' hour' : ' hours') + (m ? ' ' + m + ' min' : '');
    }
    return {
      title: dayFmt.format(toDate(day.date)),
      lines: [line, percent(day.up, day.checks) + ' uptime from ' + day.checks + (day.checks === 1 ? ' check' : ' checks')],
    };
  }

  /* -- Banner --------------------------------------------------------- */

  function banner(data) {
    var box = el('section', 'st-banner');
    var dot = el('span', 'st-dot');
    dot.setAttribute('aria-hidden', 'true');
    var text = el('div', 'st-banner-text');
    var head = el('strong', 'st-banner-head');
    var sub = el('p', 'st-banner-sub');
    var c = data && data.current;
    var age = c ? Date.now() - Date.parse(c.at) : Infinity;

    if (!c) {
      box.classList.add('is-unknown');
      head.textContent = 'No checks yet';
      sub.textContent = 'The first check runs within five minutes of monitoring starting.';
    } else if (age > STALE_MS) {
      box.classList.add('is-unknown');
      head.textContent = 'Status unknown';
      sub.textContent = 'The last check ran ' + ago(age) + ', so this may be out of date.';
    } else if (c.ok) {
      box.classList.add('is-ok');
      head.textContent = UP_TEXT;
      sub.textContent = LABEL + ' answered the last check, ' + ago(age) + ', in ' + (c.ms / 1000).toFixed(1) + 's.';
    } else {
      box.classList.add('is-down');
      head.textContent = LABEL + ' is not responding';
      sub.textContent = 'The last check, ' + ago(age) + ', ' +
        (c.status ? 'got an error (HTTP ' + c.status + ').' : 'got no answer.');
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

  function bars() { return Array.prototype.slice.call(root.querySelectorAll('.st-bar')); }

  function visibleBars() {
    return bars().filter(function (b) { return b.offsetParent !== null; });
  }

  function row(data) {
    var wrap = el('div', 'st-row');
    var head = el('div', 'st-row-head');
    var name = el('span', 'st-name');
    var nameDot = el('span', 'st-dot');
    nameDot.setAttribute('aria-hidden', 'true');
    var state = !data.current ? 'unknown' : data.current.ok ? 'ok' : 'down';
    name.classList.add('is-' + state);
    name.appendChild(nameDot);
    name.appendChild(document.createTextNode(LABEL));

    var uptime = el('span', 'st-uptime');
    uptime.appendChild(el('span', 'st-long', uptimeOver(data.days)));
    uptime.appendChild(el('span', 'st-short', uptimeOver(data.days.slice(-30))));
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
    // Keyboard: the list is one tab stop, the arrow keys walk the days.
    list.addEventListener('keydown', function (e) {
      var shown = visibleBars();
      if (!shown.length) return;
      var current = shown.indexOf(root.querySelector('.st-bar.is-active'));
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
      if (root.querySelector('.st-bar.is-active')) return;
      var shown = visibleBars();
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

  function card(data) {
    var box = el('section', 'st-card');
    var head = el('header', 'st-card-head');
    head.appendChild(el('h2', null, 'System status'));
    var first = toDate(data.days[0].date), firstShort = toDate(data.days[data.days.length - 30].date);
    var last = toDate(data.days[data.days.length - 1].date);
    var range = el('span', 'st-range');
    range.appendChild(el('span', 'st-long', monthFmt.format(first) + ' to ' + monthFmt.format(last)));
    range.appendChild(el('span', 'st-short', monthFmt.format(firstShort) + ' to ' + monthFmt.format(last)));
    head.appendChild(range);
    box.appendChild(head);
    box.appendChild(row(data));
    return box;
  }

  function note(data) {
    var firstDay = null;
    data.days.some(function (d) { if (d.checks) { firstDay = d.date; return true; } return false; });
    var text = 'Checked every ' + (data.intervalMinutes || 5) + ' minutes from outside the server, so an outage shows up even when the server itself cannot report it. Days are in UTC.';
    if (firstDay && firstDay !== data.days[0].date) {
      text += ' Monitoring began on ' + dayFmt.format(toDate(firstDay)) + ', so earlier days show as no data.';
    }
    return el('p', 'st-note', text);
  }

  /* -- Load ----------------------------------------------------------- */

  function render(data) {
    hideTip();
    root.textContent = '';
    root.setAttribute('aria-busy', 'false');
    root.appendChild(banner(data));
    root.appendChild(card(data));
    root.appendChild(note(data));
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

  function load() {
    fetch(API.replace(/\/+$/, '') + '/api/status?service=' + encodeURIComponent(SERVICE), { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
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
