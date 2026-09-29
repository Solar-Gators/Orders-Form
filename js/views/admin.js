/**
 * Admin pages for users with users.manage / settings.edit (CE and Treasurer):
 *   #/admin/users     — see everyone, change roles
 *   #/admin/settings  — team info and form dropdown options
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtDate, errorBox, setFlash, takeFlash } from '../ui.js';

function tabs(active) {
  const items = [
    ['users', 'Users & roles', 'users.manage'],
    ['settings', 'Settings', 'settings.edit'],
  ].filter(([, , perm]) => auth.can(perm));
  return `<nav class="tabs">${items
    .map(([key, label]) => `<a href="#/admin/${key}" class="${key === active ? 'active' : ''}">${label}</a>`)
    .join('')}</nav>`;
}

// ---- Users --------------------------------------------------------------------

export async function renderUsers(el, { rerender }) {
  const people = await api.listProfiles();
  const roles = auth.roles;
  const me = auth.user.id;
  const counts = Object.fromEntries(roles.map((r) => [r.key, people.filter((p) => p.role === r.key).length]));

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Admin</h1>
        <p class="subtitle">${people.length} account${people.length === 1 ? '' : 's'} · ${roles
          .map((r) => `${counts[r.key]} ${esc(r.label)}`)
          .join(' · ')}</p>
      </div>
    </div>
    ${tabs('users')}
    <div class="alert alert-info small">
      New members create their own account from the sign-in page and start as <strong>Member</strong>.
      Change their role here. Only a <strong>Chief Engineer</strong> can approve requests; only the
      <strong>Treasurer</strong> can mark them Ordered and Received. Both can manage roles and settings.
      You can't change your own role.
    </div>
    <div id="user-errors"></div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Role</th></tr></thead>
        <tbody>
          ${people
            .map(
              (p) => `<tr>
                <td><strong>${esc(p.full_name || '—')}</strong>${p.id === me ? ' <span class="muted small">(you)</span>' : ''}</td>
                <td>${esc(p.email)}</td>
                <td>${fmtDate(p.created_at)}</td>
                <td>
                  <select data-user="${esc(p.id)}" aria-label="Role for ${esc(p.full_name || p.email)}" ${p.id === me ? 'disabled' : ''}>
                    ${roles.map((r) => `<option value="${esc(r.key)}" ${r.key === p.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
                  </select>
                </td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

  el.querySelectorAll('select[data-user]').forEach((select) => {
    const previous = select.value;
    select.addEventListener('change', async () => {
      const person = people.find((p) => p.id === select.dataset.user);
      const label = roles.find((r) => r.key === select.value)?.label;
      if (!confirm(`Make ${person.full_name || person.email} a ${label}?`)) {
        select.value = previous;
        return;
      }
      select.disabled = true;
      try {
        await api.setUserRole(person.id, select.value);
        setFlash(`${person.full_name || person.email} is now a ${label}.`);
        await rerender();
      } catch (err) {
        el.querySelector('#user-errors').innerHTML = errorBox(err);
        select.value = previous;
        select.disabled = false;
      }
    });
  });
}

// ---- Settings -------------------------------------------------------------------

const lines = (text) => [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];

export async function renderSettings(el, { rerender, reloadConfig }) {
  const settings = await api.getSettings();
  const general = settings.general || {};
  const form = settings.form || {};

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1></div></div>
    ${tabs('settings')}
    <div id="settings-errors"></div>
    <form id="settings-form" novalidate>
      <div class="two-col">
        <section class="card">
          <h2>Form options</h2>
          <div class="field">
            <label for="s-subsystems">Subsystems <span class="muted">(one per line)</span></label>
            <textarea id="s-subsystems" name="subsystems" rows="10">${esc((form.subsystems || []).join('\n'))}</textarea>
            <div class="hint">Renaming a subsystem doesn't change existing requests.</div>
          </div>
          <div class="field">
            <label for="s-priorities">Priorities <span class="muted">(one per line)</span></label>
            <textarea id="s-priorities" name="priorities" rows="4">${esc((form.priorities || []).join('\n'))}</textarea>
          </div>
          <div class="field">
            <label for="s-default-priority">Default priority</label>
            <input id="s-default-priority" name="defaultPriority" type="text" value="${esc(form.defaultPriority || '')}">
          </div>
        </section>
        <section class="card">
          <h2>Team</h2>
          <div class="field"><label for="s-team">Team name</label>
            <input id="s-team" name="teamName" type="text" value="${esc(general.teamName || '')}"></div>
          <div class="field"><label for="s-season">Season</label>
            <input id="s-season" name="season" type="text" value="${esc(general.season || '')}" placeholder="2026-2027"></div>
          <div class="field"><label for="s-prefix">Request ID prefix</label>
            <input id="s-prefix" name="requestIdPrefix" type="text" value="${esc(general.requestIdPrefix || '')}" maxlength="10">
            <div class="hint">New requests are numbered ${esc(general.requestIdPrefix || 'SG')}-001, -002, … Existing IDs don't change.</div></div>
          <div class="field"><label for="s-domains">Allowed sign-up email domains <span class="muted">(one per line)</span></label>
            <textarea id="s-domains" name="allowedEmailDomains" rows="2">${esc((general.allowedEmailDomains || []).join('\n'))}</textarea>
            <div class="hint">Leave empty to allow any email address.</div></div>
        </section>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save settings</button>
      </div>
    </form>`;

  el.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const priorities = lines(data.priorities);
    const nextForm = {
      ...form, // keep keys this page doesn't edit
      subsystems: lines(data.subsystems),
      priorities,
      defaultPriority: priorities.includes(data.defaultPriority.trim()) ? data.defaultPriority.trim() : priorities[0] || '',
    };
    const nextGeneral = {
      ...general,
      teamName: data.teamName.trim() || 'Solar Gators',
      season: data.season.trim(),
      requestIdPrefix: data.requestIdPrefix.trim().toUpperCase() || 'SG',
      allowedEmailDomains: lines(data.allowedEmailDomains.toLowerCase()).map((d) => d.replace(/^@/, '')),
    };
    const button = e.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api.updateSettings('form', nextForm);
      await api.updateSettings('general', nextGeneral);
      await reloadConfig();
      setFlash('Settings saved.');
      await rerender();
    } catch (err) {
      el.querySelector('#settings-errors').innerHTML = errorBox(err);
      button.disabled = false;
    }
  });
}
