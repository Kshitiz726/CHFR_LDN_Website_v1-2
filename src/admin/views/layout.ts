import { esc } from '../../utils/html.js';
import type { UserRow } from '../../repositories/users.js';

export interface LayoutOptions {
  title: string;
  active: string;
  user: UserRow;
  body: string;
  head?: string;
  scripts?: string;
}

const NAV: Array<{ href: string; label: string; key: string; adminOnly?: boolean }> = [
  { href: '/admin', label: 'Overview', key: 'overview' },
  { href: '/admin/bookings', label: 'Bookings', key: 'bookings' },
  { href: '/admin/today', label: "Today", key: 'today' },
  { href: '/admin/upcoming', label: 'Upcoming', key: 'upcoming' },
  { href: '/admin/whatsapp', label: 'WhatsApp', key: 'whatsapp' },
  { href: '/admin/diagnostics', label: 'Diagnostics', key: 'diagnostics' },
  { href: '/admin/users', label: 'Users', key: 'users', adminOnly: true },
];

export function adminLayout(opts: LayoutOptions): string {
  const links = NAV.filter((n) => !n.adminOnly || opts.user.role === 'ADMIN')
    .map(
      (n) =>
        `<a href="${n.href}" class="${n.key === opts.active ? 'on' : ''}">${esc(n.label)}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0c0c0c">
<title>${esc(opts.title)} — CHFR Operations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/admin.css">
${opts.head ?? ''}
</head>
<body>
<nav class="admin-nav">
  <div class="admin-nav-inner">
    <a class="admin-brand" href="/admin"><b>CHFR</b><span>LDN.</span></a>
    <div class="admin-links">${links}</div>
    <div class="admin-user">
      <span><b>${esc(opts.user.name)}</b></span>
      <span class="role-chip">${esc(opts.user.role)}</span>
      <form method="post" action="/admin/logout" style="display:inline">
        <button class="btn ghost sm" type="submit">Sign out</button>
      </form>
    </div>
  </div>
</nav>
<main class="wrap">
${opts.body}
</main>
<script src="/admin.js"></script>
${opts.scripts ?? ''}
</body>
</html>`;
}

export function loginPage(opts: { error?: string; notice?: string; next?: string; email?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in — CHFR Operations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/admin.css">
</head>
<body>
<div class="login-shell">
  <div class="login-box">
    <div class="admin-brand"><b>CHFR</b><span>LDN.</span></div>
    <div class="kicker">Operations</div>
    <h1 style="font-size:22px;margin:8px 0 22px">Sign in</h1>
    ${opts.error ? `<div class="notice err">${esc(opts.error)}</div>` : ''}
    ${opts.notice ? `<div class="notice ok">${esc(opts.notice)}</div>` : ''}
    <form method="post" action="/admin/login" autocomplete="on">
      <input type="hidden" name="next" value="${esc(opts.next ?? '/admin')}">
      <label>Email
        <input type="email" name="email" required autocomplete="username"
               value="${esc(opts.email ?? '')}" autofocus>
      </label>
      <label>Password
        <input type="password" name="password" required autocomplete="current-password">
      </label>
      <button class="btn" type="submit" style="width:100%">Sign in</button>
    </form>
    <p class="hint">This area is private to CHFR staff. All access and changes are logged.</p>
  </div>
</div>
</body>
</html>`;
}
