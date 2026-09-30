/**
 * Admin pages for customizing the site without code:
 *   #/admin/lists       — columns, filters and default sort of each request list
 *   #/admin/appearance  — status labels & colors, priority colors
 *   #/admin/history     — every settings / permissions change, with Restore
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import {
  esc, fmtDateTime, errorBox, setFlash, takeFlash, statusBadge, COLOR_TONES, DEFAULT_STATUS_COLORS, priorityColor,
} from '../ui.js';
import { LISTS, availableColumns, availableFilters, listSettings } from '../listColumns.js';
import { requestFields, itemFields, fieldOptions } from '../formFields.js';
import { adminTabs } from './admin.js';

const toneOptions = (selected) =>
  COLOR_TONES.map((t) => `<option value="${t.key}" ${t.key === selected ? 'selected' : ''}>${esc(t.label)}</option>`).join('');

// ---- Lists ------------------------------------------------------------------------

export async function renderLists(el, { config, rerender, reloadConfig }) {
  const available = availableColumns(config);
  const byKey = new Map(available.map((c) => [c.key, c]));
  const filtersAvailable = availableFilters(config);

  // Working copy of every list's settings.
  const state = Object.fromEntries(
    Object.keys(LISTS).map((name) => {
      const s = listSettings(name, config);
      return [name, { columns: [...s.columns].filter((k) => byKey.has(k)), sort: { ...s.sort }, filters: [...(s.filters || [])] }];
    })
  );
  let dirty = false;

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Choose what each request list shows. Any request field works as a column, including ones you add in Form fields.</p></div></div>
    ${adminTabs('lists')}
    <div id="lists-errors"></div>
    <div id="lists"></div>
    <div class="form-actions sticky-actions">
      <span class="muted small" id="lists-dirty" hidden>Unsaved changes</span>
      <button type="button" class="btn btn-ghost" id="lists-discard" disabled>Discard changes</button>
      <button type="button" class="btn btn-primary" id="lists-save" disabled>Save lists</button>
    </div>`;

  const markDirty = () => {
    dirty = true;
    el.querySelector('#lists-save').disabled = false;
    el.querySelector('#lists-discard').disabled = false;
    el.querySelector('#lists-dirty').hidden = false;
  };

  const card = (name) => {
    const s = state[name];
    const def = LISTS[name];
    const chosen = s.columns.map((k) => byKey.get(k));
    const remaining = available.filter((c) => !s.columns.includes(c.key));
    const sortable = chosen.filter((c) => c.sort);
    return `<section class="card list-card" data-list="${name}">
      <div class="card-head"><div><h2>${esc(def.label)}</h2><p class="muted small">${esc(def.help)}</p></div>
        <button type="button" class="btn btn-sm btn-ghost" data-reset="${name}">Reset to default</button></div>

      <h3 class="sub-heading">Columns</h3>
      <ol class="column-list">
        ${chosen
          .map(
            (c, i) => `<li>
              <span class="column-name">${esc(c.label)}${c.key === 'title' ? ' <span class="field-tag">Always shown</span>' : ''}</span>
              <span class="column-actions">
                <button type="button" class="icon-btn" data-move="${i}:-1" aria-label="Move ${esc(c.label)} left" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="icon-btn" data-move="${i}:1" aria-label="Move ${esc(c.label)} right" ${i === chosen.length - 1 ? 'disabled' : ''}>↓</button>
                ${c.key === 'title' ? '' : `<button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(c.label)}">&times;</button>`}
              </span>
            </li>`
          )
          .join('')}
      </ol>
      ${
        remaining.length
          ? `<div class="add-column"><select data-add-column aria-label="Add a column to ${esc(def.label)}">
              <option value="">+ Add a column…</option>
              <optgroup label="Request fields">${remaining.filter((c) => c.fromField).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</optgroup>
              <optgroup label="Other">${remaining.filter((c) => !c.fromField).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</optgroup>
            </select></div>`
          : ''
      }
      <p class="muted small preview-line">Preview: ${chosen.map((c) => esc(c.label)).join(' · ')}</p>

      <h3 class="sub-heading">Default sort</h3>
      <div class="sort-default">
        <select data-sort-key aria-label="Default sort column">${sortable
          .map((c) => `<option value="${esc(c.key)}" ${c.key === s.sort.key ? 'selected' : ''}>${esc(c.label)}</option>`)
          .join('')}</select>
        <select data-sort-dir aria-label="Default sort direction">
          <option value="asc" ${s.sort.dir === 'asc' ? 'selected' : ''}>Ascending (A → Z, oldest, lowest)</option>
          <option value="desc" ${s.sort.dir === 'desc' ? 'selected' : ''}>Descending (Z → A, newest, highest)</option>
        </select>
      </div>

      ${
        def.filters
          ? `<h3 class="sub-heading">Filters above the list</h3>
            <div class="filter-checks">${filtersAvailable
              .map(
                (f) => `<label class="role-chip ${s.filters.includes(f.key) ? 'on' : ''}"><input type="checkbox" data-filter-key="${esc(f.key)}"
                  ${s.filters.includes(f.key) ? 'checked' : ''}>${esc(f.label)}</label>`
              )
              .join('')}</div>`
          : ''
      }
    </section>`;
  };

  const draw = () => {
    el.querySelector('#lists').innerHTML = Object.keys(LISTS).map(card).join('');
  };

  const listOf = (node) => node.closest('[data-list]')?.dataset.list;
  // Keep the default sort on a column that's still shown.
  const fixSort = (s) => {
    const sortable = s.columns.filter((k) => byKey.get(k)?.sort);
    if (!sortable.includes(s.sort.key)) s.sort = { key: sortable[0], dir: s.sort.dir };
  };

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const name = listOf(btn);
    if (name && btn.dataset.move) {
      const [i, d] = btn.dataset.move.split(':').map(Number);
      const cols = state[name].columns;
      [cols[i], cols[i + d]] = [cols[i + d], cols[i]];
    } else if (name && btn.dataset.remove) {
      state[name].columns.splice(Number(btn.dataset.remove), 1);
      fixSort(state[name]);
    } else if (btn.dataset.reset) {
      const d = LISTS[btn.dataset.reset];
      state[btn.dataset.reset] = { columns: [...d.columns].filter((k) => byKey.has(k)), sort: { ...d.sort }, filters: [...(d.filters || [])] };
    } else if (btn.id === 'lists-discard') {
      dirty = false;
      return rerender();
    } else if (btn.id === 'lists-save') {
      return save(btn);
    } else return;
    markDirty();
    draw();
  });

  el.addEventListener('change', (e) => {
    const name = listOf(e.target);
    if (!name) return;
    const s = state[name];
    if (e.target.matches('[data-add-column]') && e.target.value) s.columns.push(e.target.value);
    else if (e.target.matches('[data-sort-key]')) s.sort.key = e.target.value;
    else if (e.target.matches('[data-sort-dir]')) s.sort.dir = e.target.value;
    else if (e.target.matches('[data-filter-key]')) {
      // Keep filters in the order they're offered.
      const on = new Set([...el.querySelectorAll(`[data-list="${name}"] [data-filter-key]:checked`)].map((b) => b.dataset.filterKey));
      s.filters = filtersAvailable.map((f) => f.key).filter((k) => on.has(k));
    } else return;
    markDirty();
    draw();
  });

  async function save(button) {
    const errors = el.querySelector('#lists-errors');
    errors.innerHTML = '';
    button.disabled = true;
    try {
      const value = Object.fromEntries(
        Object.entries(state).map(([name, s]) => [name, LISTS[name].filters ? s : { columns: s.columns, sort: s.sort }])
      );
      await api.updateSettings('lists', value);
      await reloadConfig();
      dirty = false;
      setFlash('Lists saved.');
      await rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
      button.disabled = false;
    }
  }

  window.addEventListener('beforeunload', function guard(e) {
    if (!document.body.contains(el)) return window.removeEventListener('beforeunload', guard);
    if (dirty) e.preventDefault();
  });

  draw();
}

// ---- Appearance ---------------------------------------------------------------------

export async function renderAppearance(el, { config, rerender, reloadConfig }) {
  const a = config.appearance || {};
  const statuses = config.statuses;
  const priorities = config.priorities || [];
  // Dropdowns that can have colored answers (priority has its own section above).
  const dropdowns = [...requestFields(config), ...itemFields(config)]
    .filter((f) => !f.hidden && f.type === 'select' && f.key !== 'priority')
    .filter((f, i, all) => all.findIndex((x) => x.key === f.key) === i)
    .map((f) => ({ ...f, options: fieldOptions(f, config) }))
    .filter((f) => f.options.length);
  let logo = a.logo || ''; // data URL, or '' for the standard logo

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Rename statuses and choose colors. Only what people see changes; the workflow stays the same.</p></div></div>
    ${adminTabs('appearance')}
    <div id="appearance-errors"></div>
    <form id="appearance-form" novalidate>
      <section class="card">
        <h2>Brand</h2>
        <div class="two-col brand-grid">
          <div class="field">
            <label for="logo-file">Logo <span class="muted">(top-left and sign-in page; PNG, JPG, SVG or WebP under 300 KB)</span></label>
            <div class="logo-row">
              <div class="logo-preview"><img id="logo-preview" src="${esc(a.logo || 'assets/solar-gators-logo.png')}" alt="Logo preview"></div>
              <div>
                <input id="logo-file" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp">
                <button type="button" class="btn btn-sm btn-ghost" id="logo-reset" ${a.logo ? '' : 'hidden'}>Use the standard logo</button>
              </div>
            </div>
          </div>
          <div class="field">
            <label for="accent">Accent color <span class="muted">(buttons, highlights, the line under the header)</span></label>
            <div class="accent-row">
              <input id="accent" type="color" value="${esc(a.accent || '#f26b1d')}">
              <span class="btn btn-primary accent-sample" id="accent-sample">Sample button</span>
              <button type="button" class="btn btn-sm btn-ghost" id="accent-reset">Standard orange</button>
            </div>
          </div>
        </div>
      </section>
      <div class="two-col">
        <section class="card">
          <h2>Statuses</h2>
          <div class="table-wrap flat"><table class="table tone-table">
            <thead><tr><th>Status</th><th>Shown as</th><th>Color</th><th>Preview</th></tr></thead>
            <tbody>${statuses
              .map(
                (s) => `<tr data-status="${esc(s)}">
                  <td class="muted">${esc(s)}</td>
                  <td><input type="text" name="label" value="${esc(a.statuses?.[s]?.label || '')}" placeholder="${esc(s)}" maxlength="30" aria-label="Label for ${esc(s)}"></td>
                  <td><select name="color" aria-label="Color for ${esc(s)}">${toneOptions(a.statuses?.[s]?.color || DEFAULT_STATUS_COLORS[s])}</select></td>
                  <td data-preview></td>
                </tr>`
              )
              .join('')}</tbody>
          </table></div>
          <p class="muted small">Leave "Shown as" empty to use the standard name.</p>
        </section>
        <section class="card">
          <h2>Priorities</h2>
          <div class="table-wrap flat"><table class="table tone-table">
            <thead><tr><th>Priority</th><th>Color</th><th>Preview</th></tr></thead>
            <tbody>${priorities
              .map(
                (p) => `<tr data-priority="${esc(p)}">
                  <td>${esc(p)}</td>
                  <td><select name="color" aria-label="Color for ${esc(p)}">${toneOptions(priorityColor(p))}</select></td>
                  <td data-preview></td>
                </tr>`
              )
              .join('')}</tbody>
          </table></div>
          <p class="muted small">Priority names are edited in <a href="#/admin/settings">Settings</a> (Dropdown lists).</p>
          <label class="rule-toggle"><input type="checkbox" name="showDefaultPriority" ${a.showDefaultPriority ? 'checked' : ''}>
            <span>Show "${esc(config.defaultPriority || 'Normal')}" in lists too
              <span class="hint">Off: lists only tag requests that aren't the default priority, so urgent ones stand out.</span></span></label>
        </section>
      </div>
      ${
        dropdowns.length
          ? `<section class="card">
              <h2>Dropdown colors</h2>
              <p class="muted small">Give dropdown answers a color in lists and on request pages, e.g. one per Cost center. "None" shows plain text.</p>
              <div class="dropdown-colors">${dropdowns
                .map(
                  (f) => `<div class="dropdown-color-group" data-dd="${esc(f.key)}">
                    <h3 class="sub-heading">${esc(f.label)}</h3>
                    <table class="table tone-table"><tbody>${f.options
                      .map(
                        (o) => `<tr data-option="${esc(o)}"><td>${esc(o)}</td>
                          <td><select name="dd-color" aria-label="Color for ${esc(o)}"><option value="">None</option>${toneOptions(a.optionColors?.[f.key]?.[o] || '')}</select></td>
                          <td data-preview></td></tr>`
                      )
                      .join('')}</tbody></table>
                  </div>`
                )
                .join('')}</div>
            </section>`
          : ''
      }
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="appearance-reset">Reset all to defaults</button>
        <button type="submit" class="btn btn-primary">Save appearance</button>
      </div>
    </form>`;

  const form = el.querySelector('#appearance-form');
  const preview = () => {
    form.querySelectorAll('tr[data-status]').forEach((tr) => {
      const label = tr.querySelector('[name=label]').value.trim() || tr.dataset.status;
      tr.querySelector('[data-preview]').innerHTML = `<span class="badge tone-${esc(tr.querySelector('[name=color]').value)}">${esc(label)}</span>`;
    });
    form.querySelectorAll('tr[data-priority]').forEach((tr) => {
      tr.querySelector('[data-preview]').innerHTML = `<span class="priority tone-${esc(tr.querySelector('[name=color]').value)}">${esc(tr.dataset.priority)}</span>`;
    });
    form.querySelectorAll('tr[data-option]').forEach((tr) => {
      const t = tr.querySelector('[name=dd-color]').value;
      tr.querySelector('[data-preview]').innerHTML = t ? `<span class="chip-tone tone-${esc(t)}">${esc(tr.dataset.option)}</span>` : esc(tr.dataset.option);
    });
    const accent = form.querySelector('#accent').value;
    const sample = form.querySelector('#accent-sample');
    sample.style.background = accent;
    sample.style.borderColor = accent;
  };

  // Logo: read the file in the browser and keep it as a data URL in the settings.
  form.querySelector('#logo-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const errors = el.querySelector('#appearance-errors');
    errors.innerHTML = '';
    if (!file) return;
    if (file.size > 300 * 1024) {
      errors.innerHTML = errorBox(new Error('That image is over 300 KB. Try a smaller PNG or an SVG.'));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      logo = reader.result;
      form.querySelector('#logo-preview').src = logo;
      form.querySelector('#logo-reset').hidden = false;
    };
    reader.readAsDataURL(file);
  });
  form.querySelector('#logo-reset').addEventListener('click', (e) => {
    logo = '';
    form.querySelector('#logo-preview').src = 'assets/solar-gators-logo.png';
    form.querySelector('#logo-file').value = '';
    e.target.hidden = true;
  });
  form.querySelector('#accent-reset').addEventListener('click', () => {
    form.querySelector('#accent').value = '#f26b1d';
    preview();
  });
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);

  el.querySelector('#appearance-reset').addEventListener('click', () => {
    form.querySelectorAll('tr[data-status]').forEach((tr) => {
      tr.querySelector('[name=label]').value = '';
      tr.querySelector('[name=color]').value = DEFAULT_STATUS_COLORS[tr.dataset.status];
    });
    const defaults = { normal: 'gray', low: 'gray', medium: 'amber', high: 'amber', urgent: 'red-strong' };
    form.querySelectorAll('tr[data-priority]').forEach((tr) => {
      tr.querySelector('[name=color]').value = defaults[tr.dataset.priority.toLowerCase()] || 'gray';
    });
    form.showDefaultPriority.checked = false;
    form.querySelectorAll('[name=dd-color]').forEach((s) => (s.value = ''));
    form.querySelector('#accent').value = '#f26b1d';
    form.querySelector('#logo-reset').click();
    preview();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = {
      ...a,
      statuses: Object.fromEntries(
        [...form.querySelectorAll('tr[data-status]')].map((tr) => [
          tr.dataset.status,
          { label: tr.querySelector('[name=label]').value.trim(), color: tr.querySelector('[name=color]').value },
        ])
      ),
      priorities: Object.fromEntries([...form.querySelectorAll('tr[data-priority]')].map((tr) => [tr.dataset.priority, tr.querySelector('[name=color]').value])),
      showDefaultPriority: form.showDefaultPriority.checked,
      optionColors: Object.fromEntries(
        [...form.querySelectorAll('[data-dd]')].map((g) => [
          g.dataset.dd,
          Object.fromEntries([...g.querySelectorAll('tr[data-option]')].map((tr) => [tr.dataset.option, tr.querySelector('[name=dd-color]').value]).filter(([, v]) => v)),
        ])
      ),
      logo,
      accent: form.querySelector('#accent').value.toLowerCase() === '#f26b1d' ? '' : form.querySelector('#accent').value.toLowerCase(),
    };
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api.updateSettings('appearance', value);
      await reloadConfig();
      setFlash('Appearance saved.');
      await rerender();
    } catch (err) {
      el.querySelector('#appearance-errors').innerHTML = errorBox(err);
      button.disabled = false;
    }
  });

  preview();
}

// ---- History ------------------------------------------------------------------------

const WHAT = {
  general: 'Team settings',
  form: 'Form fields & dropdowns',
  lists: 'Lists',
  appearance: 'Appearance',
  permissions: 'Permissions',
};
// Which permission restoring each kind of version needs (the database checks it too).
const RESTORE_PERM = { general: 'settings.edit', form: 'settings.edit', lists: 'site.customize', appearance: 'site.customize', permissions: 'users.manage' };

const PART = {
  requestFields: 'request fields', itemFields: 'item fields', subsystems: 'subsystem list', priorities: 'priority list',
  defaultPriority: 'default priority', oneVendorPerRequest: 'one-vendor rule', teamName: 'team name',
  requestIdPrefix: 'request ID prefix', allowedEmailDomains: 'allowed email domains', statuses: 'status labels & colors',
  showDefaultPriority: 'default priority display', requests: 'Requests list', approvals: 'Approvals list',
  treasurerToOrder: 'Treasurer "To order" list', treasurerOrdered: 'Treasurer "Awaiting delivery" list',
};

/** A one-line description of what changed between two versions. */
function describe(entry, previous, roleLabel) {
  if (!previous) return entry.note || 'Starting point';
  if (entry.key === 'permissions') {
    const lines = [];
    for (const role of new Set([...Object.keys(entry.value), ...Object.keys(previous.value)])) {
      const now = new Set(entry.value[role] || []);
      const before = new Set(previous.value[role] || []);
      const added = [...now].filter((p) => !before.has(p));
      const removed = [...before].filter((p) => !now.has(p));
      if (!(role in previous.value)) lines.push(`new role ${roleLabel(role)}`);
      else if (!(role in entry.value)) lines.push(`removed role ${roleLabel(role)}`);
      else if (added.length || removed.length)
        lines.push(`${roleLabel(role)}: ${[...added.map((p) => `+${p}`), ...removed.map((p) => `−${p}`)].join(', ')}`);
    }
    return lines.join('; ') || 'No visible change';
  }
  const keys = new Set([...Object.keys(entry.value), ...Object.keys(previous.value)]);
  const changed = [...keys].filter((k) => JSON.stringify(entry.value[k]) !== JSON.stringify(previous.value[k]));
  // Same key, different meaning: in Appearance, "priorities" are the colors.
  const part = (k) => (entry.key === 'appearance' && k === 'priorities' ? 'priority colors' : PART[k] || k);
  return changed.length ? `Changed ${changed.map(part).join(', ')}` : 'No visible change';
}

export async function renderHistory(el, { rerender, reloadConfig }) {
  let rows;
  try {
    rows = await api.listSettingsHistory(200);
  } catch {
    el.innerHTML = `${adminTabs('history')}<div class="alert alert-info">Settings history needs database update <code>008_roles_admin_history.sql</code>.</div>`;
    return;
  }
  const roleLabel = (key) => auth.roles.find((r) => r.key === key)?.label || key;
  // Newest first; the newest entry for each kind is what's in use now.
  const current = new Set();
  const seen = new Set();
  for (const r of rows) if (!seen.has(r.key)) (seen.add(r.key), current.add(r.id));
  const previousOf = (r) => rows.find((x) => x.key === r.key && x.id < r.id);

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Every change to settings and permissions. Restore any earlier version; restoring is itself recorded, so it can be undone too.</p></div></div>
    ${adminTabs('history')}
    <div id="history-errors"></div>
    <div class="toolbar">
      <select id="history-kind" aria-label="Show"><option value="">Everything</option>${Object.entries(WHAT)
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
        .join('')}</select>
    </div>
    <div class="table-wrap">
      <table class="table stack-mobile history-table">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Change</th><th></th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr data-kind="${esc(r.key)}">
              <td class="nowrap" data-label="When">${fmtDateTime(r.changed_at)}</td>
              <td data-label="Who">${esc(r.changed_by_name || '—')}</td>
              <td data-label="What"><strong>${esc(WHAT[r.key] || r.key)}</strong></td>
              <td data-label="Change" class="cell-primary">${esc(describe(r, previousOf(r), roleLabel))}${r.note && previousOf(r) ? `<div class="muted small">${esc(r.note)}</div>` : ''}</td>
              <td data-label="">${
                current.has(r.id)
                  ? '<span class="field-tag">In use</span>'
                  : auth.can(RESTORE_PERM[r.key])
                    ? `<button type="button" class="btn btn-sm" data-restore="${r.id}">Restore</button>`
                    : ''
              }</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>
    </div>`;

  el.querySelector('#history-kind').addEventListener('change', (e) => {
    el.querySelectorAll('tr[data-kind]').forEach((tr) => (tr.hidden = !!e.target.value && tr.dataset.kind !== e.target.value));
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-restore]');
    if (!btn) return;
    const row = rows.find((r) => String(r.id) === btn.dataset.restore);
    if (!confirm(`Restore ${WHAT[row.key] || row.key} to how it was on ${fmtDateTime(row.changed_at)}? You can undo this from this page.`)) return;
    btn.disabled = true;
    try {
      await api.restoreSettingsVersion(row.id);
      await auth.refresh();
      await reloadConfig();
      setFlash(`${WHAT[row.key] || row.key} restored.`);
      await rerender();
    } catch (err) {
      el.querySelector('#history-errors').innerHTML = errorBox(err);
      btn.disabled = false;
    }
  });
}
