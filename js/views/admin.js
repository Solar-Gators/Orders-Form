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
    ${adminTabs('settings')}
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
