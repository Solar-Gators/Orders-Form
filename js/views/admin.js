/**
 * Admin pages for users with users.manage / settings.edit (CE and Treasurer):
 *   #/admin/users     — see everyone, change roles
 *   #/admin/settings  — team info and form dropdown options
 *   #/admin/fields    — the request form's fields (see js/formFields.js)
 *   #/admin/import    — import old spreadsheets (js/views/importPage.js)
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtDate, errorBox, setFlash, takeFlash } from '../ui.js';
import { FIELD_TYPES, LOCKED, LIST_FIELDS, requestFields, itemFields, typeLabel, makeKey } from '../formFields.js';

export function adminTabs(active) {
  const items = [
    ['users', 'Users & roles', 'users.manage'],
    ['fields', 'Form fields', 'settings.edit'],
    ['settings', 'Settings', 'settings.edit'],
    ['import', 'Import', 'settings.edit'],
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
    ${adminTabs('users')}
    <div class="alert alert-info small">
      New members create their own account from the sign-in page and start as <strong>Member</strong>.
      Change anyone's role here, including your own. What each role can do is set under
      <a href="#permissions">Permissions</a> below. At least one person must always be able to manage people,
      so the site won't let the last one lose that ability.
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
                  <select data-user="${esc(p.id)}" aria-label="Role for ${esc(p.full_name || p.email)}">
                    ${roles.map((r) => `<option value="${esc(r.key)}" ${r.key === p.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
                  </select>
                </td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div id="permissions-section"></div>`;

  el.querySelectorAll('select[data-user]').forEach((select) => {
    const previous = select.value;
    select.addEventListener('change', async () => {
      const person = people.find((p) => p.id === select.dataset.user);
      const label = roles.find((r) => r.key === select.value)?.label;
      const self = person.id === me;
      const question = self
        ? `Change your own role to ${label}? You'll immediately have only what a ${label} can do.`
        : `Make ${person.full_name || person.email} a ${label}?`;
      if (!confirm(question)) {
        select.value = previous;
        return;
      }
      select.disabled = true;
      try {
        await api.setUserRole(person.id, select.value);
        if (self) await auth.refresh(); // your menus and access change right away
        setFlash(self ? `You are now a ${label}.` : `${person.full_name || person.email} is now a ${label}.`);
        await rerender();
      } catch (err) {
        el.querySelector('#user-errors').innerHTML = errorBox(err);
        select.value = previous;
        select.disabled = false;
      }
    });
  });

  await renderPermissions(el.querySelector('#permissions-section'), { rerender });
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
  const myRole = auth.user.role;

  box.innerHTML = `
    <section class="card" id="permissions">
      <h2>Permissions</h2>
      <p class="muted small">Choose what each role can do. Everyone signed in can always submit requests, see all requests,
        search the Archive, and export. Changes apply to everyone with that role as soon as you save.</p>
      <div id="perm-errors"></div>
      <div class="table-wrap flat">
        <table class="table perm-table">
          <thead><tr><th>Permission</th>${roles.map((r) => `<th class="center">${esc(r.label)}${r.key === myRole ? '<div class="muted small">(your role)</div>' : ''}</th>`).join('')}</tr></thead>
          <tbody>${perms
            .map(
              (p) => `<tr>
                <td><strong>${esc(p.label)}</strong><div class="muted small">${esc(p.description)}</div></td>
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
    const own = toSave.includes(myRole) ? ' This includes your own role.' : '';
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

export async function renderSettings(el, { rerender, reloadConfig }) {
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

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1></div></div>
    ${adminTabs('settings')}
    <div id="settings-errors"></div>
    <form id="settings-form" novalidate>
      <div class="two-col">
        <section class="card">
          <h2>Dropdown lists</h2>
          <p class="muted small">Every dropdown on the request form. To add a new dropdown, go to
            <a href="#/admin/fields">Form fields</a>, add a field, and set its type to <strong>Dropdown</strong>. It then appears here.
            Renaming an option doesn't change requests that already used the old one.</p>
          ${visibleLists.map(listBox).join('') || '<p class="muted">There are no dropdowns on the form.</p>'}
          ${
            hiddenLists.length
              ? `<details class="hidden-lists"><summary>Hidden on the form (${hiddenLists.length})</summary>${hiddenLists.map(listBox).join('')}</details>`
              : ''
          }
        </section>
        <section class="card">
          <h2>Team</h2>
          <div class="field"><label for="s-team">Team name</label>
            <input id="s-team" name="teamName" type="text" value="${esc(general.teamName || '')}"></div>
          <div class="field"><label>Current season</label>
            <div class="readonly-value">${esc(general.season || '—')}
              <span class="muted small">· new requests are numbered ${esc(currentPrefix)}-001, -002, …</span></div>
            <div class="hint">Change it with <a href="#season-card">Start a new season</a> below.</div></div>
          <div class="field"><label for="s-prefix">Request ID prefix</label>
            <input id="s-prefix" name="requestIdPrefix" type="text" value="${esc(general.requestIdPrefix || '')}" maxlength="10">
            <div class="hint">Each new season adds its year: ${esc(general.requestIdPrefix || 'SG')} → ${esc(nextPrefix)}-001 for ${esc(nextSeason)}.</div></div>
          <div class="field"><label for="s-domains">Allowed sign-up email domains <span class="muted">(one per line)</span></label>
            <textarea id="s-domains" name="allowedEmailDomains" rows="2">${esc((general.allowedEmailDomains || []).join('\n'))}</textarea>
            <div class="hint">Leave empty to allow any email address.</div></div>
        </section>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save settings</button>
      </div>
    </form>

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
      <p class="muted small">Also remember: give next year's Chief Engineer and Treasurer their roles in Users &amp; roles, and add them to the Supabase project and GitHub repo.</p>
      <div id="season-errors"></div>
      <div class="season-row">
        <label for="new-season" class="sr-only">New season</label>
        <input id="new-season" type="text" value="${esc(nextSeason)}" placeholder="2027-2028" maxlength="9">
        <button type="button" class="btn btn-primary" id="start-season">Start ${esc(nextSeason)}</button>
      </div>`
      }
    </section>`;

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

  el.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const errors = el.querySelector('#settings-errors');

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
    const nextGeneral = {
      ...general,
      teamName: data.teamName.trim() || 'Solar Gators',
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

// ---- Form fields ----------------------------------------------------------------

/**
 * Edit requestFields / itemFields. Built-in fields can be renamed, reordered,
 * hidden and made optional (except LOCKED ones); custom fields can also be
 * added, retyped and deleted. Nothing is saved until "Save form".
 */
export async function renderFormFields(el, { rerender, reloadConfig }) {
  const settings = await api.getSettings();
  const form = settings.form || {};
  const lists = {
    request: requestFields(form).map((f) => ({ ...f })),
    item: itemFields(form).map((f) => ({ ...f })),
  };
  let dirty = false;

  const typeSelect = (f) =>
    `<select data-prop="type" aria-label="Type of ${esc(f.label)}">${FIELD_TYPES.map(
      (t) => `<option value="${t.key}" ${t.key === f.type ? 'selected' : ''}>${esc(t.label)}</option>`
    ).join('')}</select>`;

  const optionsCell = (f) => {
    if (f.builtin && LIST_FIELDS[f.key]) return `<a href="#/admin/settings" class="small">Edit list in Settings</a>`;
    if (!f.builtin && f.type === 'select') {
      return `<textarea data-prop="options" rows="2" placeholder="One option per line" aria-label="Options for ${esc(f.label)}">${esc(
        (f.options || []).join('\n')
      )}</textarea>`;
    }
    return '<span class="muted small">—</span>';
  };

  const row = (kind, f, idx, count) => {
    const locked = LOCKED.has(f.key);
    return `<tr data-kind="${kind}" data-index="${idx}" class="${f.hidden ? 'is-hidden' : ''}">
      <td class="move">
        <button type="button" class="icon-btn" data-move="-1" title="Move up" aria-label="Move ${esc(f.label)} up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-move="1" title="Move down" aria-label="Move ${esc(f.label)} down" ${idx === count - 1 ? 'disabled' : ''}>↓</button>
      </td>
      <td><input type="text" data-prop="label" value="${esc(f.label)}" aria-label="Label"></td>
      <td>${f.builtin ? `<span class="muted">${esc(typeLabel(f.type))}</span>` : typeSelect(f)}</td>
      <td class="center"><input type="checkbox" data-prop="required" ${f.required ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="Required"></td>
      <td class="center"><input type="checkbox" data-prop="shown" ${f.hidden ? '' : 'checked'} ${locked ? 'disabled' : ''} aria-label="Shown"></td>
      <td>${optionsCell(f)}</td>
      <td><input type="text" data-prop="help" value="${esc(f.help || '')}" placeholder="Optional hint" aria-label="Help text"></td>
      <td class="center">${
        f.builtin
          ? `<span class="field-tag" title="${locked ? 'Always shown and required' : 'Built-in: can be hidden, not deleted'}">${locked ? 'Locked' : 'Built-in'}</span>`
          : `<button type="button" class="icon-btn" data-delete title="Delete field" aria-label="Delete ${esc(f.label)}">&times;</button>`
      }</td>
    </tr>`;
  };

  const section = (kind, title, blurb) => `
    <section class="card">
      <div class="card-head">
        <div><h2>${title}</h2><p class="muted small">${blurb}</p></div>
        <button type="button" class="btn btn-sm" data-add="${kind}">+ Add field</button>
      </div>
      <div class="table-wrap flat">
        <table class="table fields-table">
          <thead><tr>
            <th class="move">Order</th><th>Label</th><th>Type</th><th class="center">Required</th><th class="center">Shown</th>
            <th>Options</th><th>Help text</th><th></th>
          </tr></thead>
          <tbody data-list="${kind}"></tbody>
        </table>
      </div>
    </section>`;

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Admin</h1>
        <p class="subtitle">Changes apply to new and edited requests. The Excel export follows this form too.</p>
      </div>
      <a class="btn" href="#/new" target="_blank" rel="noopener">Preview form ↗</a>
    </div>
    ${adminTabs('fields')}
    <div id="fields-errors"></div>
    ${section('request', 'Request fields', 'Asked once per request.')}
    ${section('item', 'Item fields', 'Asked for every item (one row each). The item total is always Quantity × Unit price.')}
    <div class="alert alert-info small">
      <strong>Locked</strong> fields are always shown and required because approvals and totals depend on them.
      Hiding a field removes it from the form and export; answers already saved stay in the database and come back if you show it again.
    </div>
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

  el.addEventListener('input', (e) => {
    const t = target(e.target);
    const prop = e.target.dataset.prop;
    if (!t || !['label', 'help', 'options'].includes(prop)) return;
    const f = t.list[t.idx];
    if (prop === 'options') f.options = e.target.value.split('\n').map((o) => o.trim()).filter(Boolean);
    else f[prop] = e.target.value;
    markDirty();
  });

  el.addEventListener('change', (e) => {
    const t = target(e.target);
    const prop = e.target.dataset.prop;
    if (!t || !['required', 'shown', 'type'].includes(prop)) return;
    const f = t.list[t.idx];
    if (prop === 'required') f.required = e.target.checked;
    if (prop === 'shown') f.hidden = !e.target.checked;
    if (prop === 'type') f.type = e.target.value;
    markDirty();
    if (prop !== 'required') draw(); // type changes the options cell; shown changes row styling
  });

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const t = target(btn);
    if (btn.dataset.move && t) {
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
      lists[btn.dataset.add].push({ label: 'New field', type: 'text', required: false });
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
        const out = { key, label, type: f.type, required: !!f.required };
        if (f.builtin) out.builtin = true;
        if (f.hidden) out.hidden = true;
        if (f.help?.trim()) out.help = f.help.trim();
        if (!f.builtin && f.type === 'select') out.options = f.options;
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

  // Warn before closing the tab with unsaved edits.
  const beforeUnload = (e) => {
    if (!document.body.contains(el)) return window.removeEventListener('beforeunload', beforeUnload);
    if (dirty) e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);

  draw();
}
