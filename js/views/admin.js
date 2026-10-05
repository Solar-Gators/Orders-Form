/**
 * Admin pages for users with users.manage / settings.edit (CE and Treasurer):
 *   #/admin/users      — see everyone, change roles
 *   #/admin/roles      — roles and what each can do
 *   #/admin/fields     — the request form's fields (see js/formFields.js)
 *   #/admin/dropdowns  — dropdown options and request rules
 *   #/admin/season     — team info and starting a new season
 * Shared: adminHeader() — the Admin title, section tabs and sub-tabs.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtDate, errorBox, setFlash, takeFlash } from '../ui.js';
import { guardLeaving } from '../leaveGuard.js';
import { renderImport } from './importPage.js';
import {
  FIELD_TYPES, LOCKED, LIST_FIELDS, CONDITION_OPS, requestFields, itemFields, typeLabel, makeKey, fieldOptions, describeCondition,
} from '../formFields.js';

/**
 * Admin pages, each shown only with its permission, grouped into a few tabs.
 * Also used by the router. [key, label, permissions, group, hidden]
 * Hidden pages are reached from another page: Request page / Request lists / Excel
 * templates are sections of "Lists, layout & Excel", Import is part of "Team & season",
 * and History opens from the "History" link on each page.
 */
export const ADMIN_TABS = [
  ['users', 'Users', ['users.manage'], 'Team'],
  ['roles', 'Roles & permissions', ['users.manage'], 'Team'],
  ['season', 'Team & season', ['settings.edit', 'seasons.manage'], 'Team'],
  ['fields', 'Fields', ['settings.edit'], 'Request form'],
  ['dropdowns', 'Dropdowns & rules', ['settings.edit'], 'Request form'],
  ['display', 'Lists, layout & Excel', ['site.customize'], 'Display'],
  ['appearance', 'Colors & logo', ['site.customize'], 'Display'],
  ['text', 'Text & banner', ['site.customize'], 'Display'],
  ['workflow', 'Approval rules', ['workflow.edit'], 'Approvals & alerts'],
  ['notifications', 'Notifications', ['workflow.edit'], 'Approvals & alerts'],
  ['lists', 'Request lists', ['site.customize'], 'Display', true],
  ['page', 'Request page', ['site.customize'], 'Display', true],
  ['exports', 'Excel templates', ['site.customize'], 'Display', true],
  ['import', 'Import', ['seasons.manage'], 'Team', true],
  ['history', 'History', ['users.manage', 'settings.edit', 'site.customize', 'workflow.edit'], 'Team', true],
];
/** Where a hidden page lives. */
const PARENT = { lists: 'display', page: 'display', exports: 'display', import: 'season' };
/** Which settings each page changes, for its "History" link. */
const HISTORY_KEYS = {
  users: 'permissions', roles: 'permissions', season: 'general', fields: 'form', dropdowns: 'form',
  display: 'lists,layout,exports', lists: 'lists', page: 'layout', exports: 'exports',
  appearance: 'appearance', text: 'appearance', workflow: 'workflow', notifications: 'notifications',
};

/**
 * Top of every Admin page: title, one tab per group, the group's pages as small
 * sub-tabs, and a one-line intro. Phones get a single "jump to" menu instead.
 * `actions` is extra HTML for the right of the title (e.g. a Preview button).
 */
export function adminHeader(active, intro = '', actions = '') {
  const page = PARENT[active] || active;
  const items = ADMIN_TABS.filter(([, , perms, , hidden]) => !hidden && perms.some((p) => auth.can(p)));
  const group = ADMIN_TABS.find(([key]) => key === page)?.[3];
  const groups = [...new Set(items.map((t) => t[3]))];
  const here = (on) => (on ? 'class="active" aria-current="page"' : '');
  const tabs = groups
    .map((g) => `<a href="#/admin/${items.find((t) => t[3] === g)[0]}" ${here(g === group && page !== 'history')}>${esc(g)}</a>`)
    .join('');
  const siblings = items.filter((t) => t[3] === group);
  const subnav = siblings.length > 1 && page !== 'history'
    ? `<nav class="admin-subnav" aria-label="${esc(group)}">${siblings.map(([key, label]) => `<a href="#/admin/${key}" ${here(key === page)}>${esc(label)}</a>`).join('')}</nav>`
    : '';
  const jump = `<label class="admin-jump"><span class="sr-only">Admin page</span><select data-admin-jump>${page === 'history' ? '<option value="history" selected>History</option>' : ''}${groups
    .map((g) => `<optgroup label="${esc(g)}">${items
      .filter((t) => t[3] === g)
      .map(([key, label]) => `<option value="${key}" ${key === page ? 'selected' : ''}>${esc(label)}</option>`)
      .join('')}</optgroup>`)
    .join('')}</select></label>`;
  const canHistory = ADMIN_TABS.find((t) => t[0] === 'history')[2].some((p) => auth.can(p));
  const history = canHistory && HISTORY_KEYS[active]
    ? `<a class="btn btn-sm btn-ghost" href="#/admin/history/${HISTORY_KEYS[active]}" title="Earlier versions of this page's settings">History</a>`
    : '';
  return `<div class="admin-top">
    <div class="page-header admin-head"><div><h1>Admin</h1></div><div class="card-actions">${history}${actions}</div></div>
    <nav class="tabs admin-tabs" aria-label="Admin">${tabs}</nav>
    ${jump}${subnav}
    ${intro ? `<p class="admin-intro">${intro}</p>` : ''}
  </div>`;
}

/** A page shown inside another one (e.g. Import inside Team & season) gets only its intro line. */
export const adminTop = (key, intro, embedded) => (embedded ? `<p class="admin-intro section-intro">${intro}</p>` : adminHeader(key, intro));

// The phone menu: pick a page to go there.
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-admin-jump]')) location.hash = `#/admin/${e.target.value}`;
});

/** A short "how this works" note that opens on click, instead of a big box on every visit. */
export const about = (html, summary = 'How this works') =>
  `<details class="about"><summary>${esc(summary)}</summary><div>${html}</div></details>`;

// ---- Users --------------------------------------------------------------------

export const renderUsers = (el, ctx) => renderPeople(el, ctx, 'users');
export const renderRoles = (el, ctx) => renderPeople(el, ctx, 'roles');

async function renderPeople(el, { rerender }, part) {
  const people = await api.listProfiles();
  const roles = auth.roles;
  const me = auth.user.id;
  // Member is what you are with no other role, so it isn't a checkbox.
  const assignable = roles.filter((r) => r.key !== 'member');
  const BUILT_IN = new Set(['member', 'ce', 'treasurer', 'admin']);
  const holds = (p, key) => (p.roles || []).includes(key);
  const count = (key) => people.filter((p) => (key === 'member' ? !p.roles.some((r) => r !== 'member') : holds(p, key))).length;

  const summary = `${people.length} account${people.length === 1 ? '' : 's'} · ${roles.map((r) => `${count(r.key)} ${esc(r.label)}`).join(' · ')}`;
  const usersPart = `
    ${about(`New people create their own account from the sign-in page and start as <strong>Member</strong>.
      Tick the roles each person should have. Someone can have several (e.g. Treasurer + Admin) and gets everything those roles allow.
      What each role can do is set under <a href="#/admin/roles">Roles &amp; permissions</a>. At least one person must always be able to
      manage people &amp; roles, so the site won't let the last one lose that ability.`)}
    <div id="user-errors"></div>
    <div class="toolbar">
      <input type="search" id="people-q" placeholder="Search name or email" aria-label="Search people">
      <select id="people-filter" aria-label="Show">
        <option value="">Everyone</option>
        <option value="leads">Only people with a role</option>
        ${assignable.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('')}
      </select>
      <span class="muted" id="people-count">${people.length} people</span>
    </div>
    <div class="table-wrap">
      <table class="table people-table stack-mobile">
        <thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Roles</th></tr></thead>
        <tbody>
          ${people
            .map(
              (p) => `<tr data-user="${esc(p.id)}">
                <td class="cell-primary" data-label=""><strong>${esc(p.full_name || '—')}</strong>${p.id === me ? ' <span class="muted small">(you)</span>' : ''}</td>
                <td data-label="Email">${esc(p.email)}</td>
                <td class="nowrap" data-label="Joined">${fmtDate(p.created_at)}</td>
                <td data-label="Roles"><div class="role-chips">
                  ${assignable
                    .map(
                      (r) => `<label class="role-chip ${holds(p, r.key) ? 'on' : ''}">
                        <input type="checkbox" data-role="${esc(r.key)}" ${holds(p, r.key) ? 'checked' : ''}
                          aria-label="${esc(r.label)} for ${esc(p.full_name || p.email)}">${esc(r.label)}</label>`
                    )
                    .join('')}
                </div></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
  const rolesPart = `
    <section class="card" id="roles">
      <h2>Roles</h2>
      <p class="muted small">Add roles like "Subsystem Lead" or "Faculty Advisor", then choose what they can do under Permissions.
        Built-in roles can be renamed but not deleted.</p>
      <div id="role-errors"></div>
      <div class="table-wrap flat">
        <table class="table roles-table stack-mobile">
          <thead><tr><th>Role</th><th class="num">People</th><th></th></tr></thead>
          <tbody>${roles
            .map(
              (r) => `<tr data-role-row="${esc(r.key)}">
                <td class="cell-primary" data-label=""><div class="rename-row">
                  <input type="text" value="${esc(r.label)}" data-rename="${esc(r.key)}" aria-label="Name of the ${esc(r.label)} role" maxlength="40">
                  <button type="button" class="btn btn-sm" data-save-name="${esc(r.key)}" hidden>Rename</button>
                </div></td>
                <td class="num" data-label="People">${count(r.key)}</td>
                <td class="center" data-label="">${
                  BUILT_IN.has(r.key)
                    ? '<span class="field-tag">Built-in</span>'
                    : `<button type="button" class="btn btn-sm btn-danger" data-delete-role="${esc(r.key)}">Delete</button>`
                }</td>
              </tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
      <form class="add-role" id="add-role" novalidate>
        <label for="new-role" class="sr-only">New role name</label>
        <input id="new-role" type="text" placeholder="New role, e.g. Subsystem Lead" maxlength="40">
        <button type="submit" class="btn">+ Add role</button>
      </form>
    </section>

    <div id="permissions-section"></div>`;

  el.innerHTML = `
    ${takeFlash()}
    ${adminHeader(part, part === 'users' ? summary : 'Rename roles, add new ones, and choose what each can do.')}
    ${part === 'users' ? usersPart : rolesPart}`;

  const userErrors = el.querySelector('#user-errors');
  const roleErrors = el.querySelector('#role-errors');
  const label = (key) => roles.find((r) => r.key === key)?.label || key;

  // Find someone: by name / email, and by role.
  const filterPeople = () => {
    const words = el.querySelector('#people-q').value.toLowerCase().split(/\s+/).filter(Boolean);
    const role = el.querySelector('#people-filter').value;
    let shown = 0;
    for (const p of people) {
      const row = el.querySelector(`tr[data-user="${CSS.escape(p.id)}"]`);
      const text = `${p.full_name} ${p.email}`.toLowerCase();
      const ok = words.every((w) => text.includes(w)) &&
        (!role || (role === 'leads' ? p.roles.some((r) => r !== 'member') : holds(p, role)));
      row.hidden = !ok;
      if (ok) shown++;
    }
    el.querySelector('#people-count').textContent = shown === people.length ? `${people.length} people` : `${shown} of ${people.length} people`;
  };
  el.querySelector('#people-q')?.addEventListener('input', filterPeople);
  el.querySelector('#people-filter')?.addEventListener('change', filterPeople);

  // Tick / untick a role for someone: saved right away.
  el.querySelectorAll('tr[data-user] input[data-role]').forEach((box) =>
    box.addEventListener('change', async () => {
      const row = box.closest('tr');
      const person = people.find((p) => p.id === row.dataset.user);
      const next = [...row.querySelectorAll('input[data-role]:checked')].map((b) => b.dataset.role);
      const self = person.id === me;
      if (self && !box.checked && !confirm(`Remove your own ${label(box.dataset.role)} role? You'll lose what it lets you do right away.`)) {
        box.checked = true;
        return;
      }
      row.querySelectorAll('input').forEach((b) => (b.disabled = true));
      userErrors.innerHTML = '';
      try {
        await api.setUserRoles(person.id, next);
        if (self) await auth.refresh(); // your menus and access change right away
        const who = self ? 'You' : person.full_name || person.email;
        setFlash(`${who} ${self ? 'are' : 'is'} now: ${next.length ? next.map(label).join(' + ') : 'Member'}.`);
        await rerender();
      } catch (err) {
        userErrors.innerHTML = errorBox(err);
        box.checked = !box.checked;
        row.querySelectorAll('input').forEach((b) => (b.disabled = false));
      }
    })
  );

  // Rename: the button appears once the name changes.
  el.querySelectorAll('input[data-rename]').forEach((input) => {
    const button = el.querySelector(`[data-save-name="${input.dataset.rename}"]`);
    input.addEventListener('input', () => (button.hidden = input.value.trim() === label(input.dataset.rename)));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), button.click()));
    button.addEventListener('click', async () => {
      roleErrors.innerHTML = '';
      try {
        await api.renameRole(input.dataset.rename, input.value.trim());
        await auth.refresh();
        setFlash(`Renamed to "${input.value.trim()}".`);
        await rerender();
      } catch (err) {
        roleErrors.innerHTML = errorBox(err);
      }
    });
  });

  el.querySelectorAll('[data-delete-role]').forEach((button) =>
    button.addEventListener('click', async () => {
      const key = button.dataset.deleteRole;
      if (!confirm(`Delete the ${label(key)} role? ${count(key)} ${count(key) === 1 ? 'person loses' : 'people lose'} it (anyone left with no role becomes a Member).`)) return;
      roleErrors.innerHTML = '';
      try {
        await api.deleteRole(key);
        await auth.refresh();
        setFlash(`Deleted the ${label(key)} role.`);
        await rerender();
      } catch (err) {
        roleErrors.innerHTML = errorBox(err);
      }
    })
  );

  el.querySelector('#add-role')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.querySelector('#new-role').value.trim();
    if (!name) return;
    roleErrors.innerHTML = '';
    try {
      await api.createRole(name);
      await auth.refresh();
      setFlash(`Added the "${name}" role. Choose what it can do under Permissions.`);
      await rerender();
    } catch (err) {
      roleErrors.innerHTML = errorBox(err);
    }
  });

  if (part === 'roles') await renderPermissions(el.querySelector('#permissions-section'), { rerender });
}

// ---- Permissions (what each role can do) -------------------------------------------

async function renderPermissions(box, { rerender }) {
  let perms, grants;
  try {
    [perms, grants] = await Promise.all([api.listPermissions(), api.listRolePermissions()]);
  } catch {
    box.innerHTML = `<section class="card" id="permissions"><h2>Permissions</h2>
      <p class="muted">Editing permissions needs database update <code>005_editable_permissions.sql</code>.</p></section>`;
    return;
  }
  const roles = auth.roles;
  const has = new Set(grants.map((g) => `${g.role}|${g.permission}`));
  const myRoles = auth.user.roles || [];

  box.innerHTML = `
    <section class="card" id="permissions">
      <h2>Permissions</h2>
      <p class="muted small">Choose what each role can do. Everyone signed in can always submit requests, see all requests,
        search the Archive, and export. Changes apply to everyone with that role as soon as you save.</p>
      <div id="perm-errors"></div>
      <div class="table-wrap flat">
        <table class="table perm-table stack-mobile">
          <thead><tr><th>Permission</th>${roles.map((r) => `<th class="center">${esc(r.label)}${myRoles.includes(r.key) ? '<div class="muted small">(yours)</div>' : ''}</th>`).join('')}</tr></thead>
          <tbody>${perms
            .map(
              (p) => `<tr>
                <td class="cell-primary" data-label=""><strong>${esc(p.label)}</strong><div class="muted small">${esc(p.description)}</div></td>
                ${roles
                  .map(
                    (r) => `<td class="center" data-label="${esc(r.label)}"><input type="checkbox" data-role="${esc(r.key)}" data-grant="${esc(p.key)}"
                      ${has.has(`${r.key}|${p.key}`) ? 'checked' : ''} aria-label="${esc(r.label)}: ${esc(p.label)}"></td>`
                  )
                  .join('')}
              </tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
      <div class="form-actions">
        <span class="muted small" id="perm-dirty" hidden>Unsaved changes</span>
        <button type="button" class="btn btn-primary" id="save-perms" disabled>Save permissions</button>
      </div>
    </section>`;

  const boxes = [...box.querySelectorAll('input[data-grant]')];
  const changedRoles = () =>
    [...new Set(boxes.filter((b) => b.checked !== has.has(`${b.dataset.role}|${b.dataset.grant}`)).map((b) => b.dataset.role))];

  box.addEventListener('change', () => {
    const dirty = changedRoles().length > 0;
    box.querySelector('#save-perms').disabled = !dirty;
    box.querySelector('#perm-dirty').hidden = !dirty;
  });

  box.querySelector('#save-perms').addEventListener('click', async (e) => {
    const toSave = changedRoles();
    const label = (key) => roles.find((r) => r.key === key)?.label || key;
    const own = toSave.some((r) => myRoles.includes(r)) ? ' This includes one of your own roles.' : '';
    if (!confirm(`Save new permissions for ${toSave.map(label).join(', ')}?${own}`)) return;
    e.target.disabled = true;
    box.querySelector('#perm-errors').innerHTML = '';
    try {
      // One save for all changed roles: all-or-nothing, and the "someone can still
      // manage people" check runs on the final result.
      const matrix = Object.fromEntries(
        toSave.map((role) => [role, boxes.filter((b) => b.dataset.role === role && b.checked).map((b) => b.dataset.grant)])
      );
      await api.setPermissionMatrix(matrix);
      await auth.refresh();
      setFlash('Permissions saved.');
      await rerender();
    } catch (err) {
      box.querySelector('#perm-errors').innerHTML = errorBox(err);
      e.target.disabled = false;
    }
  });
}

// ---- Settings -------------------------------------------------------------------

const lines = (text) => [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];

/** "Dropdowns & rules" (form options) and "Team & season" share this page code. */
export const renderDropdowns = (el, ctx) => renderSettings(el, ctx, 'dropdowns');
export async function renderSeason(el, ctx) {
  await renderSettings(el, ctx, 'season');
  if (!auth.can('seasons.manage')) return;
  const box = document.createElement('div');
  box.className = 'import-section';
  el.appendChild(box);
  await renderImport(box, { ...ctx, embedded: true });
}

async function renderSettings(el, { rerender, reloadConfig }, part) {
  const settings = await api.getSettings();
  const general = settings.general || {};
  const form = settings.form || {};

  // Season rollover: "2026-2027" → "2027-2028", numbered SG27-001…
  const startYear = Number((general.season || '').split('-')[0]) || new Date().getFullYear();
  const nextSeason = `${startYear + 1}-${startYear + 2}`;
  const basePrefix = general.requestIdPrefix || 'SG';
  const nextPrefix = `${basePrefix}${String(startYear + 1).slice(-2)}`;
  const currentPrefix = general.seasonPrefix || basePrefix;

  // Every dropdown on the form — built-in (Subsystem, Priority) and ones added in
  // Form fields — gets an options box here. Shown fields first, hidden ones after.
  const dropdowns = [
    ...requestFields(form).map((f) => ({ ...f, kind: 'request', where: 'Request' })),
    ...itemFields(form).map((f) => ({ ...f, kind: 'item', where: 'Each item' })),
  ]
    .filter((f) => f.type === 'select')
    .map((f) => ({ ...f, options: f.builtin && LIST_FIELDS[f.key] ? form[LIST_FIELDS[f.key]] || [] : f.options || [] }));
  const listBox = (f) => {
    const id = `dd-${f.kind}-${f.key}`;
    return `<div class="field ${f.hidden ? 'is-hidden-field' : ''}">
      <label for="${esc(id)}">${esc(f.label)} <span class="muted">(${esc(f.where)} · one per line)</span></label>
      <textarea id="${esc(id)}" data-kind="${esc(f.kind)}" data-key="${esc(f.key)}" rows="${Math.min(10, Math.max(3, f.options.length + 1))}">${esc(f.options.join('\n'))}</textarea>
      ${f.key === 'priority' && f.builtin ? `<label for="s-default-priority" class="sub-label">Default ${esc(f.label.toLowerCase())}</label>
        <input id="s-default-priority" name="defaultPriority" type="text" value="${esc(form.defaultPriority || '')}">` : ''}
    </div>`;
  };
  const visibleLists = dropdowns.filter((f) => !f.hidden);
  const hiddenLists = dropdowns.filter((f) => f.hidden);

  const dropdownsPart = `
    <form id="settings-form" novalidate>
      <div class="two-col">
        <section class="card">
          <h2>Dropdown lists</h2>
          <p class="muted small">Every dropdown on the request form. To add a new dropdown, go to
            <a href="#/admin/fields">Fields</a>, add a field, and set its type to <strong>Dropdown</strong>. It then appears here.
            Renaming an option doesn't change requests that already used the old one. Colors are under <a href="#/admin/appearance">Colors &amp; logo</a>.</p>
          ${visibleLists.map(listBox).join('') || '<p class="muted">There are no dropdowns on the form.</p>'}
          ${
            hiddenLists.length
              ? `<details class="hidden-lists"><summary>Hidden on the form (${hiddenLists.length})</summary>${hiddenLists.map(listBox).join('')}</details>`
              : ''
          }
        </section>
        <section class="card">
          <h2>Request rules</h2>
          <div class="field">
            <label class="rule-toggle">
              <input type="checkbox" name="oneVendorPerRequest" ${form.oneVendorPerRequest !== false ? 'checked' : ''}>
              <span>One vendor per request
                <span class="hint">Each request is a single purchase: the vendor is entered once and applies to every item. Items from another vendor go in a separate request.</span></span>
            </label>
          </div>
          <div class="field">
            <label class="rule-toggle">
              <input type="checkbox" name="shippingPerRequest" ${form.shippingPerRequest !== false ? 'checked' : ''}>
              <span>Shipping is one total per request
                <span class="hint">Requesters enter the order's shipping once (as the vendor charges it), not on every item. Turn off to enter shipping per item.</span></span>
            </label>
          </div>
          <div class="field">
            <label class="rule-toggle">
              <input type="checkbox" name="requireOrderNumber" ${form.requireOrderNumber !== false ? 'checked' : ''}>
              <span>Ticket / Dept. order number is required
                <span class="hint">The Treasurer must enter it when marking a request Ordered. Turn off if some orders don't get one.</span></span>
            </label>
          </div>
        </section>
      </div>
      <div class="form-actions sticky-actions">
        <button type="submit" class="btn btn-primary">Save dropdowns &amp; rules</button>
      </div>
    </form>`;

  const teamCard = `
    <form id="settings-form" class="card" novalidate>
      <h2>Team</h2>
      <div class="field"><label for="s-team">Team name</label>
        <input id="s-team" name="teamName" type="text" value="${esc(general.teamName || '')}"></div>
      <div class="field"><label>Current season</label>
        <div class="readonly-value">${esc(general.season || '—')}
          <span class="muted small">· new requests are numbered ${esc(currentPrefix)}-001, -002, …</span></div></div>
      <div class="field"><label for="s-prefix">Request ID prefix</label>
        <input id="s-prefix" name="requestIdPrefix" type="text" value="${esc(general.requestIdPrefix || '')}" maxlength="10">
        <div class="hint">Each new season adds its year: ${esc(general.requestIdPrefix || 'SG')} → ${esc(nextPrefix)}-001 for ${esc(nextSeason)}.</div></div>
      <div class="field"><label for="s-domains">Allowed sign-up email domains <span class="muted">(one per line)</span></label>
        <textarea id="s-domains" name="allowedEmailDomains" rows="2">${esc((general.allowedEmailDomains || []).join('\n'))}</textarea>
        <div class="hint">Leave empty to allow any email address.</div></div>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Save team settings</button></div>
    </form>`;

  const seasonCard = `
    <section class="card season-card" id="season-card">
      <h2>Start a new season</h2>
      ${
        (Number(general.schemaVersion) || 1) < 6
          ? '<p class="muted">Starting a new season needs database update <code>006_seasons.sql</code>.</p>'
          : `<p>Do this once a year, when the new season's orders begin. Starting <strong>${esc(nextSeason)}</strong> will:</p>
      <ul class="season-steps">
        <li>Number new requests <strong>${esc(nextPrefix)}-001</strong>, <strong>${esc(nextPrefix)}-002</strong>, … (${esc(general.season)} keeps its numbers).</li>
        <li>Show only ${esc(nextSeason)} on the <strong>Requests</strong> and <strong>Export</strong> pages by default. There's a season picker to look back.</li>
        <li>Move ${esc(general.season)}'s requests into the <strong>Archive</strong>, where they're searchable with their full history.</li>
        <li>Keep anything still waiting on approval, ordering, or delivery in the <strong>Approvals</strong> and <strong>Treasurer</strong> queues, labeled ${esc(general.season)}, until it's finished.</li>
      </ul>
      <p class="muted small">Also remember: give next year's Chief Engineer and Treasurer their roles in <a href="#/admin/users">Users</a>, and add them to the Supabase project and GitHub repo.</p>
      <div id="season-errors"></div>
      <div class="season-row">
        <label for="new-season" class="sr-only">New season</label>
        <input id="new-season" type="text" value="${esc(nextSeason)}" placeholder="2027-2028" maxlength="9">
        <button type="button" class="btn btn-primary" id="start-season">Start ${esc(nextSeason)}</button>
      </div>`
      }
    </section>`;

  el.innerHTML = `
    ${takeFlash()}
    ${adminHeader(part, part === 'dropdowns'
      ? 'The options in each dropdown, and rules that apply to every request.'
      : 'Team name, request numbers, who can sign up, the yearly season change, and importing old spreadsheets.')}
    <div id="settings-errors"></div>
    ${part === 'dropdowns'
      ? dropdownsPart
      : `<div class="two-col">${auth.can('settings.edit') ? teamCard : ''}${auth.can('seasons.manage') ? seasonCard : ''}</div>`}`;

  el.querySelector('#new-season')?.addEventListener('input', (e) => {
    el.querySelector('#start-season').textContent = `Start ${e.target.value.trim() || 'season'}`;
  });
  el.querySelector('#start-season')?.addEventListener('click', async (e) => {
    const season = el.querySelector('#new-season').value.trim();
    const typedPrefix = /^\d{4}-\d{4}$/.test(season) ? `${basePrefix}${season.slice(2, 4)}` : nextPrefix;
    if (!confirm(`Start the ${season} season now? New requests will be numbered from ${typedPrefix}-001, and ${general.season} moves to the Archive. This can't be undone from the website.`)) return;
    e.target.disabled = true;
    el.querySelector('#season-errors').innerHTML = '';
    try {
      const prefix = await api.startNewSeason(season);
      await reloadConfig();
      setFlash(`Welcome to ${season}! New requests will be numbered ${prefix}-001, ${prefix}-002, …`);
      location.hash = '#/requests';
    } catch (err) {
      el.querySelector('#season-errors').innerHTML = errorBox(err);
      e.target.disabled = false;
    }
  });

  el.querySelector('#settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const errors = el.querySelector('#settings-errors');

    const button = e.target.querySelector('button[type="submit"]');
    if (part === 'season') {
      const nextGeneral = {
        ...general,
        teamName: data.teamName.trim() || 'Solar Gators',
        requestIdPrefix: data.requestIdPrefix.trim().toUpperCase() || 'SG',
        allowedEmailDomains: lines(data.allowedEmailDomains.toLowerCase()).map((d) => d.replace(/^@/, '')),
      };
      button.disabled = true;
      try {
        await api.updateSettings('general', nextGeneral);
        await reloadConfig();
        setFlash('Team settings saved.');
        await rerender();
      } catch (err) {
        errors.innerHTML = errorBox(err);
        button.disabled = false;
      }
      return;
    }

    // Collect every dropdown's options from its box.
    const nextForm = {
      ...form, // keep keys this page doesn't edit
      requestFields: requestFields(form).map((f) => ({ ...f })),
      itemFields: itemFields(form).map((f) => ({ ...f })),
    };
    const empty = [];
    for (const box of e.target.querySelectorAll('textarea[data-key]')) {
      const options = lines(box.value);
      const list = box.dataset.kind === 'request' ? nextForm.requestFields : nextForm.itemFields;
      const field = list.find((f) => f.key === box.dataset.key);
      if (!options.length) empty.push(field.label);
      if (field.builtin && LIST_FIELDS[field.key]) nextForm[LIST_FIELDS[field.key]] = options;
      else field.options = options;
    }
    if (empty.length) {
      errors.innerHTML = errorBox(Object.assign(new Error('Every dropdown needs at least one option:'), { details: empty }));
      errors.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const priorities = nextForm.priorities || [];
    const wanted = (data.defaultPriority ?? form.defaultPriority ?? '').trim();
    nextForm.defaultPriority = priorities.includes(wanted) ? wanted : priorities[0] || '';
    nextForm.oneVendorPerRequest = data.oneVendorPerRequest === 'on';
    nextForm.shippingPerRequest = data.shippingPerRequest === 'on';
    nextForm.requireOrderNumber = data.requireOrderNumber === 'on';
    button.disabled = true;
    try {
      await api.updateSettings('form', nextForm);
      await reloadConfig();
      setFlash('Dropdowns & rules saved.');
      await rerender();
    } catch (err) {
      el.querySelector('#settings-errors').innerHTML = errorBox(err);
      button.disabled = false;
    }
  });

}

// ---- Form fields ----------------------------------------------------------------

/**
 * Edit requestFields / itemFields. Built-in fields can be renamed, reordered,
 * hidden and made optional (except LOCKED ones); custom fields can also be
 * added, retyped and deleted. Nothing is saved until "Save form".
 */
export async function renderFormFields(el, { rerender, reloadConfig }) {
  const settings = await api.getSettings();
  const form = settings.form || {};
  let uid = 0; // tracks which rows have their Rules panel open, even as rows move
  const lists = {
    request: requestFields(form).map((f) => ({ ...f, _uid: ++uid })),
    item: itemFields(form).map((f) => ({ ...f, _uid: ++uid })),
  };
  const openRules = new Set();
  let dirty = false;

  const typeSelect = (kind, f) =>
    `<select data-prop="type" aria-label="Type of ${esc(f.label)}">${FIELD_TYPES.filter((t) => kind === 'request' || !t.requestOnly)
      .map((t) => `<option value="${t.key}" ${t.key === f.type ? 'selected' : ''}>${esc(t.label)}</option>`)
      .join('')}</select>`;

  // ---- Rules: "show only when…", min / max, max length, default ----------------------
  /** Fields a condition can look at: saved fields that take an answer (items can also look at request fields). */
  const fieldKeys = (except = null) => new Set([...lists.request, ...lists.item].filter((x) => x !== except && x.key).map((x) => x.key));
  const conditionTargets = (kind, f) => {
    const usable = (list) => list.filter((x) => x.key && x !== f && x.type !== 'section' && !x.hidden);
    return kind === 'request'
      ? usable(lists.request).map((x) => ({ ...x, group: '' }))
      : [...usable(lists.item).map((x) => ({ ...x, group: 'This item' })), ...usable(lists.request).map((x) => ({ ...x, group: 'The request' }))];
  };
  const optionsOf = (x) => (x.type === 'yesno' ? ['Yes', 'No'] : fieldOptions(x, form));
  const rulesSummary = (kind, f) => {
    const parts = [];
    if (f.showIf?.field) parts.push(`Only when ${describeCondition(f.showIf, [...lists.request, ...lists.item])}`);
    if (f.min !== undefined && f.min !== '') parts.push(`min ${f.min}`);
    if (f.max !== undefined && f.max !== '') parts.push(`max ${f.max}`);
    if (f.maxLength) parts.push(`≤ ${f.maxLength} chars`);
    if (f.default !== undefined && f.default !== '') parts.push(`default "${f.default}"`);
    return parts.join(' · ');
  };
  const rulesPanel = (kind, f) => {
    const locked = LOCKED.has(f.key);
    const targets = conditionTargets(kind, f);
    const c = f.showIf || {};
    const tgt = targets.find((x) => x.key === c.field);
    const op = CONDITION_OPS.find((o) => o.key === c.op) || CONDITION_OPS[0];
    const values = Array.isArray(c.value) ? c.value : c.value !== undefined && c.value !== '' ? [c.value] : [];
    const valueInput = !op.needsValue
      ? ''
      : tgt && ['select', 'yesno'].includes(tgt.type)
        ? op.many
          ? `<span class="cond-multi">${optionsOf(tgt)
              .map((o) => `<label class="role-chip ${values.includes(o) ? 'on' : ''}"><input type="checkbox" data-rule="cond-multi" value="${esc(o)}" ${values.includes(o) ? 'checked' : ''}>${esc(o)}</label>`)
              .join('')}</span>`
          : `<select data-rule="cond-value" aria-label="Value"><option value="">Choose…</option>${optionsOf(tgt)
              .map((o) => `<option value="${esc(o)}" ${values[0] === o ? 'selected' : ''}>${esc(o)}</option>`)
              .join('')}</select>`
        : `<input type="text" data-rule="cond-value" value="${esc(values.join(', '))}" placeholder="${op.many ? 'Values, separated by commas' : 'Value'}" aria-label="Value">`;
    const groups = [...new Set(targets.map((x) => x.group))];
    const targetOptions = groups
      .map((g) => {
        const opts = targets.filter((x) => x.group === g).map((x) => `<option value="${esc(x.key)}" ${x.key === c.field ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
        return g ? `<optgroup label="${esc(g)}">${opts}</optgroup>` : opts;
      })
      .join('');
    const isText = ['text', 'textarea', 'url'].includes(f.type);
    return `<div class="rules-panel">
      <div class="rule">
        <strong>Show only when</strong>
        ${
          locked
            ? '<span class="muted small">This field is locked: it\'s always shown.</span>'
            : `<select data-rule="cond-field" aria-label="Field to check"><option value="">Always show this field</option>${targetOptions}</select>
              ${c.field ? `<select data-rule="cond-op" aria-label="Rule">${CONDITION_OPS.map((o) => `<option value="${o.key}" ${o.key === op.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${valueInput}` : ''}
              <div class="hint">Hidden fields aren't required and their answers aren't saved.</div>`
        }
      </div>
      ${
        f.type === 'number'
          ? `<div class="rule"><strong>Allowed range</strong>
              <input type="number" step="any" data-rule="min" value="${esc(f.min ?? '')}" placeholder="Min" aria-label="Minimum">
              <span class="muted">to</span>
              <input type="number" step="any" data-rule="max" value="${esc(f.max ?? '')}" placeholder="Max" aria-label="Maximum"></div>`
          : ''
      }
      ${
        isText
          ? `<div class="rule"><strong>Maximum length</strong>
              <input type="number" min="1" max="5000" step="1" data-rule="maxLength" value="${esc(f.maxLength ?? '')}" placeholder="No limit" aria-label="Maximum length"> <span class="muted">characters</span></div>`
          : ''
      }
      ${
        f.type !== 'section' && !['title', 'item_name'].includes(f.key)
          ? `<div class="rule"><strong>Default value</strong>
              ${
                ['select', 'yesno'].includes(f.type)
                  ? `<select data-rule="default" aria-label="Default value"><option value="">None</option>${optionsOf(f)
                      .map((o) => `<option value="${esc(o)}" ${f.default === o ? 'selected' : ''}>${esc(o)}</option>`)
                      .join('')}</select>`
                  : `<input type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" data-rule="default" value="${esc(f.default ?? '')}" placeholder="None" aria-label="Default value">`
              }
              <span class="hint">Pre-filled on new requests.</span></div>`
          : ''
      }
    </div>`;
  };

  const optionsCell = (f) => {
    // Saved dropdowns: options are edited in one place, Dropdowns & rules.
    if ((f.builtin && LIST_FIELDS[f.key]) || (f.type === 'select' && !f._new)) return `<a href="#/admin/dropdowns" class="small">Edit options</a>`;
    if (!f.builtin && f.type === 'select') {
      return `<textarea data-prop="options" rows="2" placeholder="One option per line" aria-label="Options for ${esc(f.label)}">${esc(
        (f.options || []).join('\n')
      )}</textarea>`;
    }
    return '<span class="muted small">—</span>';
  };

  const row = (kind, f, idx, count) => {
    const locked = LOCKED.has(f.key);
    const summary = rulesSummary(kind, f);
    const open = openRules.has(f._uid);
    const rules = `<tr class="rules-row" data-kind="${kind}" data-index="${idx}"><td data-label=""></td><td colspan="8" data-label="">${rulesPanel(kind, f)}</td></tr>`;
    return `<tr data-kind="${kind}" data-index="${idx}" class="${f.hidden ? 'is-hidden' : ''}${f.type === 'section' ? ' is-section' : ''}">
      <td class="move" data-label="Order">
        <button type="button" class="icon-btn" data-move="-1" title="Move up" aria-label="Move ${esc(f.label)} up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-move="1" title="Move down" aria-label="Move ${esc(f.label)} down" ${idx === count - 1 ? 'disabled' : ''}>↓</button>
      </td>
      <td class="cell-primary" data-label=""><input type="text" data-prop="label" value="${esc(f.label)}" aria-label="Label"></td>
      <td data-label="Type">${f.builtin ? `<span class="muted">${esc(typeLabel(f.type))}</span>` : typeSelect(kind, f)}</td>
      <td class="center" data-label="Required"><input type="checkbox" data-prop="required" ${f.required ? 'checked' : ''} ${locked || f.type === 'section' ? 'disabled' : ''} aria-label="Required"></td>
      <td class="center" data-label="Shown"><input type="checkbox" data-prop="shown" ${f.hidden ? '' : 'checked'} ${locked ? 'disabled' : ''} aria-label="Shown"></td>
      <td data-label="Options">${optionsCell(f)}</td>
      <td data-label="Help text"><input type="text" data-prop="help" value="${esc(f.help || '')}" placeholder="${f.type === 'section' ? 'Optional description' : 'Optional hint'}" aria-label="Help text"></td>
      <td class="rules-cell" data-label="Rules"><button type="button" class="btn btn-sm ${summary ? 'has-rules' : ''}" data-rules aria-expanded="${open}">${open ? 'Hide rules' : 'Rules'}</button>
        ${summary ? `<div class="muted small rules-summary">${esc(summary)}</div>` : ''}</td>
      <td class="center field-end" data-label="">${
        f.builtin
          ? `<span class="field-tag" title="${locked ? 'Always shown and required' : 'Built-in: can be hidden, not deleted'}">${locked ? 'Locked' : 'Built-in'}</span>`
          : `<button type="button" class="icon-btn" data-delete title="Delete field" aria-label="Delete ${esc(f.label)}">&times;</button>`
      }</td>
    </tr>${open ? rules : ''}`;
  };

  const section = (kind, title, blurb) => `
    <section class="card">
      <div class="card-head">
        <div><h2>${title}</h2><p class="muted small">${blurb}</p></div>
        <button type="button" class="btn btn-sm" data-add="${kind}">+ Add field</button>
      </div>
      <div class="table-wrap flat">
        <table class="table fields-table stack-mobile">
          <thead><tr>
            <th class="move">Order</th><th>Label</th><th>Type</th><th class="center">Required</th><th class="center">Shown</th>
            <th>Options</th><th>Help text</th><th>Rules</th><th></th>
          </tr></thead>
          <tbody data-list="${kind}"></tbody>
        </table>
      </div>
    </section>`;

  el.innerHTML = `
    ${takeFlash()}
    ${adminHeader('fields', 'The questions on the request form. Changes apply to new and edited requests; the Excel export follows them too.',
      '<a class="btn btn-sm" href="#/new" target="_blank" rel="noopener">Preview form ↗</a>')}
    ${about(`<strong>Locked</strong> fields are always shown and required because approvals and totals depend on them.
      Hiding a field removes it from the form and export; answers already saved stay in the database and come back if you show it again.`, 'About locked and hidden fields')}
    <div id="fields-errors"></div>
    ${section('request', 'Request fields', 'Asked once per request.')}
    ${section('item', 'Item fields', 'Asked for every item (one row each). The item total is always Quantity × Unit price.')}
    <div class="form-actions sticky-actions">
      <span class="muted small" id="dirty-note" hidden>Unsaved changes</span>
      <button type="button" class="btn btn-ghost" id="discard" disabled>Discard changes</button>
      <button type="button" class="btn btn-primary" id="save-fields" disabled>Save form</button>
    </div>`;

  const errors = el.querySelector('#fields-errors');

  const markDirty = () => {
    dirty = true;
    el.querySelector('#save-fields').disabled = false;
    el.querySelector('#discard').disabled = false;
    el.querySelector('#dirty-note').hidden = false;
  };
  const draw = () => {
    for (const kind of ['request', 'item']) {
      const list = lists[kind];
      el.querySelector(`[data-list="${kind}"]`).innerHTML = list.map((f, i) => row(kind, f, i, list.length)).join('');
    }
  };
  const target = (node) => {
    const tr = node.closest('tr[data-kind]');
    return tr && { list: lists[tr.dataset.kind], idx: Number(tr.dataset.index) };
  };

  /** Apply a Rules-panel control to its field. Returns true if the panel should redraw. */
  const applyRule = (f, input) => {
    const rule = input.dataset.rule;
    const c = (f.showIf ??= {});
    if (rule === 'cond-field') {
      if (!input.value) delete f.showIf;
      else f.showIf = { field: input.value, op: c.op || 'equals', value: '' };
      return true;
    }
    if (rule === 'cond-op') {
      const op = CONDITION_OPS.find((o) => o.key === input.value);
      c.op = input.value;
      c.value = op.many ? (Array.isArray(c.value) ? c.value : c.value ? [c.value] : []) : Array.isArray(c.value) ? c.value[0] || '' : c.value || '';
      if (!op.needsValue) delete c.value;
      return true;
    }
    if (rule === 'cond-value') {
      const op = CONDITION_OPS.find((o) => o.key === c.op);
      c.value = op?.many ? input.value.split(',').map((v) => v.trim()).filter(Boolean) : input.value;
      return input.tagName === 'SELECT';
    }
    if (rule === 'cond-multi') {
      const row = input.closest('.rules-panel');
      c.value = [...row.querySelectorAll('[data-rule="cond-multi"]:checked')].map((b) => b.value);
      return true;
    }
    if (['min', 'max', 'maxLength', 'default'].includes(rule)) {
      if (input.value === '') delete f[rule];
      else f[rule] = input.value;
      if (!Object.keys(c).length) delete f.showIf;
      return input.tagName === 'SELECT';
    }
    if (!Object.keys(c).length) delete f.showIf;
    return false;
  };

  el.addEventListener('input', (e) => {
    const t = target(e.target);
    if (t && e.target.dataset.rule && e.target.tagName !== 'SELECT' && e.target.type !== 'checkbox') {
      applyRule(t.list[t.idx], e.target);
      markDirty();
      return;
    }
    const prop = e.target.dataset.prop;
    if (!t || !['label', 'help', 'options'].includes(prop)) return;
    const f = t.list[t.idx];
    if (prop === 'options') f.options = e.target.value.split('\n').map((o) => o.trim()).filter(Boolean);
    else f[prop] = e.target.value;
    if (prop === 'label' && f._new) {
      // Until it's saved, a new field's key follows its label; rules pointing at it follow too.
      const old = f.key;
      f.key = makeKey(f.label.trim() || 'field', fieldKeys(f));
      if (old !== f.key) for (const x of [...lists.request, ...lists.item]) if (x.showIf?.field === old) x.showIf.field = f.key;
    }
    markDirty();
  });

  el.addEventListener('change', (e) => {
    const t = target(e.target);
    if (t && e.target.dataset.rule) {
      const redraw = applyRule(t.list[t.idx], e.target) || e.target.type !== 'checkbox';
      markDirty();
      if (redraw) draw(); // refresh the summary and dependent controls
      return;
    }
    const prop = e.target.dataset.prop;
    if (!t || !['required', 'shown', 'type'].includes(prop)) return;
    const f = t.list[t.idx];
    if (prop === 'required') f.required = e.target.checked;
    if (prop === 'shown') f.hidden = !e.target.checked;
    if (prop === 'type') {
      f.type = e.target.value;
      if (f.type === 'section') f.required = false;
    }
    markDirty();
    if (prop !== 'required') draw(); // type changes the options cell; shown changes row styling
  });

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const t = target(btn);
    if (btn.hasAttribute('data-rules') && t) {
      const id = t.list[t.idx]._uid;
      openRules.has(id) ? openRules.delete(id) : openRules.add(id);
      draw();
    } else if (btn.dataset.move && t) {
      const to = t.idx + Number(btn.dataset.move);
      [t.list[t.idx], t.list[to]] = [t.list[to], t.list[t.idx]];
      markDirty();
      draw();
    } else if (btn.hasAttribute('data-delete') && t) {
      const f = t.list[t.idx];
      if (!confirm(`Delete the field "${f.label}"? Answers already saved stay in the database but won't be shown or exported.`)) return;
      t.list.splice(t.idx, 1);
      markDirty();
      draw();
    } else if (btn.dataset.add) {
      // New fields get their key right away (from the label), so other fields'
      // "Show only when" rules can use them before saving.
      lists[btn.dataset.add].push({ label: 'New field', type: 'text', required: false, _uid: ++uid, _new: true, key: makeKey('New field', fieldKeys()) });
      markDirty();
      draw();
      const inputs = el.querySelectorAll(`[data-list="${btn.dataset.add}"] input[data-prop="label"]`);
      inputs[inputs.length - 1]?.select();
    } else if (btn.id === 'discard') {
      dirty = false;
      rerender();
    } else if (btn.id === 'save-fields') {
      save(btn);
    }
  });

  async function save(button) {
    errors.innerHTML = '';
    const problems = [];
    const allKeys = new Set([...lists.request, ...lists.item].filter((f) => f.key).map((f) => f.key));
    const clean = (list) =>
      list.map((f) => {
        const label = (f.label || '').trim();
        if (!label) problems.push('Every field needs a label.');
        if (!f.builtin && f.type === 'select' && !f.options?.length) problems.push(`Add at least one option to the dropdown "${label}".`);
        let key = f.key;
        if (!key) {
          // Keys are permanent, so renaming a field later keeps its saved answers.
          key = makeKey(label, allKeys);
          allKeys.add(key);
        }
        const out = { key, label, type: f.type, required: f.type !== 'section' && !!f.required };
        if (f.builtin) out.builtin = true;
        if (f.hidden) out.hidden = true;
        if (f.help?.trim()) out.help = f.help.trim();
        if (!f.builtin && f.type === 'select') out.options = f.options;
        // Rules
        const c = f.showIf;
        if (c?.field) {
          const op = CONDITION_OPS.find((o) => o.key === c.op) || CONDITION_OPS[0];
          const hasValue = Array.isArray(c.value) ? c.value.length : String(c.value ?? '').trim() !== '';
          if (op.needsValue && !hasValue) problems.push(`"${label}": choose the value(s) for its "show only when" rule.`);
          out.showIf = op.needsValue ? { field: c.field, op: op.key, value: c.value } : { field: c.field, op: op.key };
        }
        if (f.type === 'number') {
          if (f.min !== undefined && f.min !== '') out.min = String(f.min);
          if (f.max !== undefined && f.max !== '') out.max = String(f.max);
          if (out.min !== undefined && out.max !== undefined && Number(out.min) > Number(out.max)) problems.push(`"${label}": the minimum is more than the maximum.`);
        }
        if (['text', 'textarea', 'url'].includes(f.type) && f.maxLength) out.maxLength = String(f.maxLength);
        if (f.type !== 'section' && f.default !== undefined && f.default !== '') out.default = String(f.default);
        return out;
      });
    const next = { ...form, requestFields: clean(lists.request), itemFields: clean(lists.item) };
    if (problems.length) {
      errors.innerHTML = errorBox(Object.assign(new Error('Please fix the following:'), { details: [...new Set(problems)] }));
      errors.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    button.disabled = true;
    try {
      await api.updateSettings('form', next);
      await reloadConfig();
      dirty = false;
      setFlash('Form saved.');
      await rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
      errors.scrollIntoView({ behavior: 'smooth' });
      button.disabled = false;
    }
  }

  // Warn before switching pages or closing the tab with unsaved edits.
  guardLeaving(el, () => dirty);

  draw();
}
