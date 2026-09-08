import { esc } from '../../utils/html.js';
import { formatDateTime } from '../../utils/dates.js';
import type { UserRow } from '../../repositories/users.js';
import { csrfInput, notices } from './components.js';

export interface UsersPageProps {
  users: UserRow[];
  currentUser: UserRow;
  csrf: string;
  flash: { ok?: string; err?: string; warn?: string };
}

export function usersPage(p: UsersPageProps): string {
  const csrf = csrfInput(p.csrf);

  return `
<div class="page-head">
  <div>
    <div class="kicker">Administration</div>
    <h1>Staff accounts</h1>
    <p class="sub">ADMIN can manage users, integrations and permanent deletion. STAFF can work bookings.</p>
  </div>
</div>

${notices(p.flash)}

<div class="grid2">
  <section class="panel">
    <div class="section-title">Accounts</div>
    <div class="table-scroll"><table style="min-width:0">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="nowrap">Last sign-in</th><th>Actions</th></tr></thead>
      <tbody>${p.users
        .map(
          (u) => `<tr>
          <td>${esc(u.name)}${u.id === p.currentUser.id ? '<span class="muted">You</span>' : ''}</td>
          <td class="nowrap">${esc(u.email)}</td>
          <td class="nowrap"><span class="badge">${esc(u.role)}</span></td>
          <td class="nowrap"><span class="badge ${u.active ? 'good' : 'bad'}">${u.active ? 'Active' : 'Disabled'}</span></td>
          <td class="nowrap">${esc(u.last_login_at ? formatDateTime(u.last_login_at) : 'Never')}</td>
          <td class="nowrap">${
            u.id === p.currentUser.id
              ? '<span class="muted">—</span>'
              : `<form method="post" action="/admin/users/${esc(u.id)}/toggle" style="display:inline"
                       data-confirm="${u.active ? 'Disable' : 'Enable'} ${esc(u.name)}?">
                   ${csrf}<button class="btn ghost sm" type="submit">${u.active ? 'Disable' : 'Enable'}</button>
                 </form>`
          }</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </section>

  <section class="panel">
    <div class="section-title">Add a staff account</div>
    <form method="post" action="/admin/users">
      ${csrf}
      <div class="form-grid">
        <label class="full">Name<input type="text" name="name" required minlength="2"></label>
        <label class="full">Email<input type="email" name="email" required autocomplete="off"></label>
        <label class="full">Password
          <input type="password" name="password" required minlength="12" autocomplete="new-password">
        </label>
        <label class="full">Role
          <select name="role"><option value="STAFF">STAFF</option><option value="ADMIN">ADMIN</option></select>
        </label>
      </div>
      <p class="sub" style="font-size:11.5px;margin:14px 0 16px">
        At least 12 characters, with an uppercase letter, a lowercase letter and a number.
        Passwords are stored as bcrypt hashes and are never logged or emailed.
      </p>
      <button class="btn" type="submit">Create account</button>
    </form>
  </section>
</div>

<section class="panel">
  <div class="section-title">Change your password</div>
  <form method="post" action="/admin/users/password" style="max-width:420px">
    ${csrf}
    <div class="form-grid">
      <label class="full">Current password<input type="password" name="current_password" required autocomplete="current-password"></label>
      <label class="full">New password<input type="password" name="new_password" required minlength="12" autocomplete="new-password"></label>
    </div>
    <div class="btn-row" style="margin-top:16px"><button class="btn ghost" type="submit">Update password</button></div>
  </form>
</section>`;
}
