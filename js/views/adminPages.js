/**
 * More "customize without code" Admin pages (permission: Customize lists & appearance):
 *   #/admin/page     — what a request's page shows (layout settings)
 *   #/admin/exports  — Excel export templates
 *   #/admin/text     — announcement banner, sign-in message, page intros, Help page
 */
import { api } from '../api.js';
import { esc, errorBox, setFlash, takeFlash, statusLabel, renderRichText } from '../ui.js';
import { COPY_MODES, pageLayout, detailCandidates, itemCandidates } from '../pageLayout.js';
import { exportCatalog, exportTemplates } from '../excel.js';
import { adminTabs } from './admin.js';

const move = (list, i, d) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
};

/** Warn before leaving a page with unsaved edits. */
function guardUnsaved(el, isDirty) {
  window.addEventListener('beforeunload', function guard(e) {
    if (!document.body.contains(el)) return window.removeEventListener('beforeunload', guard);
    if (isDirty()) e.preventDefault();
  });
}

// ---- Request page layout -------------------------------------------------------------

export async function renderPageLayout(el, { config, rerender, reloadConfig }) {
  const layout = pageLayout(config);
  // Working state: every candidate in display order, with shown / lead-only flags.
  const build = (candidates, chosenKeys, prefix) => {
    const byKey = new Map(candidates.map((f) => [f.key, f]));
    const order = chosenKeys ? [...chosenKeys.filter((k) => byKey.has(k)), ...candidates.map((f) => f.key).filter((k) => !chosenKeys.includes(k))] : candidates.map((f) => f.key);
    return order.map((k) => ({ field: byKey.get(k), on: !chosenKeys || chosenKeys.includes(k), leadOnly: layout.leadOnly.has(`${prefix}:${k}`) }));
  };
  const state = {
    details: build(detailCandidates(config), layout.detailFields, 'request'),
    items: build(itemCandidates(config), layout.itemColumns, 'item'),
    copyButtons: layout.copyButtons,
    itemsFirst: layout.itemsFirst,
  };
  let dirty = false;

  const rows = (kind) =>
    state[kind]
      .map((row, i) => {
        const f = row.field;
        const locked = kind === 'items' && f.key === 'item_name';
        return `<li class="${row.on ? '' : 'is-off'}${f.type === 'section' ? ' is-section' : ''}" data-kind="${kind}" data-i="${i}">
          <label class="layout-show"><input type="checkbox" data-toggle="on" ${row.on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            <span>${f.type === 'section' ? `<em>Section:</em> ` : ''}${esc(f.label)}</span></label>
          ${
            f.type === 'section' || locked
              ? '<span></span>'
              : `<label class="layout-lead" title="Only Chief Engineers and Treasurers see it"><input type="checkbox" data-toggle="leadOnly" ${row.leadOnly ? 'checked' : ''}> Leads only</label>`
          }
          <span class="column-actions">
            <button type="button" class="icon-btn" data-move="-1" aria-label="Move ${esc(f.label)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-move="1" aria-label="Move ${esc(f.label)} down" ${i === state[kind].length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </li>`;
      })
      .join('');

  const draw = () => {
    el.querySelector('#layout-body').innerHTML = `
      <div class="two-col">
        <section class="card">
          <h2>Details box</h2>
          <p class="muted small">Request fields shown on a request's page, in order. Title and priority are always in the header.</p>
          <ol class="layout-list">${rows('details')}</ol>
        </section>
        <section class="card">
          <h2>Items table</h2>
          <p class="muted small">Item fields shown as columns, in order. Notes appear under the item name.</p>
          <ol class="layout-list">${rows('items')}</ol>
        </section>
      </div>
      <section class="card">
        <h2>Options</h2>
        <div class="field">
          <label for="copy-mode">Copy buttons next to each value</label>
          <select id="copy-mode">${COPY_MODES.map((m) => `<option value="${m.key}" ${m.key === state.copyButtons ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
        </div>
        <label class="rule-toggle"><input type="checkbox" id="items-first" ${state.itemsFirst ? 'checked' : ''}>
          <span>Show Items above Details <span class="hint">Useful when people mostly check what was ordered.</span></span></label>
        <p class="muted small">"Leads only" hides a field from Members on the request page. It's a tidiness choice, not a security one: signed-in members can still see the data in exports.</p>
      </section>`;
  };

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Choose what a request's page shows. Open any request to see the result.</p></div></div>
    ${adminTabs('page')}
    <div id="layout-errors"></div>
    <div id="layout-body"></div>
    <div class="form-actions sticky-actions">
      <span class="muted small" id="layout-dirty" hidden>Unsaved changes</span>
      <button type="button" class="btn btn-ghost" id="layout-reset">Reset to default</button>
      <button type="button" class="btn btn-primary" id="layout-save" disabled>Save request page</button>
    </div>`;

  const markDirty = () => {
    dirty = true;
    el.querySelector('#layout-save').disabled = false;
    el.querySelector('#layout-dirty').hidden = false;
  };

  el.addEventListener('change', (e) => {
    const li = e.target.closest('li[data-kind]');
    if (li && e.target.dataset.toggle) {
      state[li.dataset.kind][Number(li.dataset.i)][e.target.dataset.toggle] = e.target.checked;
      markDirty();
      draw();
    } else if (e.target.id === 'copy-mode') {
      state.copyButtons = e.target.value;
      markDirty();
    } else if (e.target.id === 'items-first') {
      state.itemsFirst = e.target.checked;
      markDirty();
    }
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('li[data-kind]');
    if (li && btn.dataset.move) {
      move(state[li.dataset.kind], Number(li.dataset.i), Number(btn.dataset.move));
      markDirty();
      draw();
    } else if (btn.id === 'layout-reset') {
      state.details = build(detailCandidates(config), null, 'request').map((r) => ({ ...r, leadOnly: false }));
      state.items = build(itemCandidates(config), null, 'item').map((r) => ({ ...r, leadOnly: false }));
      state.copyButtons = 'order';
      state.itemsFirst = false;
      markDirty();
      draw();
    } else if (btn.id === 'layout-save') {
      btn.disabled = true;
      const value = {
        detailFields: state.details.filter((r) => r.on).map((r) => r.field.key),
        itemColumns: state.items.filter((r) => r.on).map((r) => r.field.key),
        leadOnly: [
          ...state.details.filter((r) => r.leadOnly).map((r) => `request:${r.field.key}`),
          ...state.items.filter((r) => r.leadOnly).map((r) => `item:${r.field.key}`),
        ],
        copyButtons: state.copyButtons,
        itemsFirst: state.itemsFirst,
      };
      try {
        await api.updateSettings('layout', value);
        await reloadConfig();
        dirty = false;
        setFlash('Request page saved.');
        await rerender();
      } catch (err) {
        el.querySelector('#layout-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
  });

  guardUnsaved(el, () => dirty);
  draw();
}

// ---- Export templates ------------------------------------------------------------------

export async function renderExportTemplates(el, { config, rerender, reloadConfig }) {
  const catalog = exportCatalog(config);
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const builtIn = exportTemplates(config)[0];
  const saved = (config.exports?.templates || []).map((t) => ({ ...t, columns: [...(t.columns || [])], statuses: [...(t.statuses || [])], headers: { ...(t.headers || {}) } }));
  let selected = saved[0]?.id || null;
  let dirty = false;

  const newId = () => `t${Date.now().toString(36)}`;
  const current = () => saved.find((t) => t.id === selected);

  const editor = (t) => {
    const cols = t.columns.filter((k) => byKey.has(k) && (t.rowPer === 'item' || !byKey.get(k).perItem));
    const remaining = catalog.filter((c) => !t.columns.includes(c.key) && (t.rowPer === 'item' || !c.perItem));
    const groups = [...new Set(remaining.map((c) => c.group))];
    return `<section class="card">
      <div class="card-head"><h2>Edit template</h2>
        <button type="button" class="btn btn-sm btn-danger" data-delete-template>Delete template</button></div>
      <div class="form-grid">
        <div class="field span-2"><label for="t-name">Name</label>
          <input id="t-name" type="text" value="${esc(t.name)}" maxlength="60" data-t="name"></div>
        <div class="field span-2"><label for="t-file">File name <span class="muted">(optional; the date is added)</span></label>
          <input id="t-file" type="text" value="${esc(t.fileName || '')}" placeholder="e.g. Dept purchasing" maxlength="60" data-t="fileName"></div>
      </div>
      <div class="field"><label>Rows</label>
        <div class="radio-row">
          <label><input type="radio" name="rowPer" value="item" ${t.rowPer !== 'request' ? 'checked' : ''} data-t="rowPer"> One row per item</label>
          <label><input type="radio" name="rowPer" value="request" ${t.rowPer === 'request' ? 'checked' : ''} data-t="rowPer"> One row per request (no item columns)</label>
        </div></div>
      <div class="field"><label>Only these statuses <span class="muted">(none ticked = all)</span></label>
        <div class="filter-checks">${config.statuses
          .map((s) => `<label class="role-chip ${t.statuses.includes(s) ? 'on' : ''}"><input type="checkbox" data-status="${esc(s)}" ${t.statuses.includes(s) ? 'checked' : ''}>${esc(statusLabel(s))}</label>`)
          .join('')}</div></div>
      <h3 class="sub-heading">Columns, in order</h3>
      <ol class="export-columns">${cols
        .map((k, i) => {
          const c = byKey.get(k);
          return `<li data-col="${esc(k)}">
            <span class="muted small">${esc(c.group)}</span>
            <input type="text" value="${esc(t.headers[k] || c.header)}" data-header="${esc(k)}" aria-label="Heading for ${esc(c.header)}">
            <span class="column-actions">
              <button type="button" class="icon-btn" data-col-move="-1" aria-label="Move left" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="icon-btn" data-col-move="1" aria-label="Move right" ${i === cols.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="icon-btn" data-col-remove aria-label="Remove ${esc(c.header)}">&times;</button>
            </span>
          </li>`;
        })
        .join('') || '<li class="muted">No columns yet — add some below.</li>'}</ol>
      ${
        remaining.length
          ? `<div class="add-column"><select data-add-col aria-label="Add a column"><option value="">+ Add a column…</option>${groups
              .map((g) => `<optgroup label="${esc(g)}">${remaining.filter((c) => c.group === g).map((c) => `<option value="${esc(c.key)}">${esc(c.header)}</option>`).join('')}</optgroup>`)
              .join('')}</select>
            <button type="button" class="btn btn-sm btn-ghost" data-add-all>Add all</button></div>`
          : ''
      }
    </section>`;
  };

  const draw = () => {
    const t = current();
    el.querySelector('#exports-body').innerHTML = `
      <section class="card">
        <h2>Templates</h2>
        <div class="table-wrap flat"><table class="table">
          <thead><tr><th>Name</th><th>Rows</th><th class="num">Columns</th><th></th></tr></thead>
          <tbody>
            <tr><td><strong>${esc(builtIn.name)}</strong> <span class="field-tag">Built-in</span></td><td>Per item</td><td class="num">${builtIn.columns.length}</td>
              <td><button type="button" class="btn btn-sm" data-duplicate="full">Duplicate</button></td></tr>
            ${saved
              .map(
                (s) => `<tr class="${s.id === selected ? 'is-selected' : ''}"><td><strong>${esc(s.name)}</strong></td><td>${s.rowPer === 'request' ? 'Per request' : 'Per item'}</td>
                  <td class="num">${s.columns.length}</td>
                  <td><button type="button" class="btn btn-sm" data-select="${esc(s.id)}">${s.id === selected ? 'Editing' : 'Edit'}</button>
                    <button type="button" class="btn btn-sm btn-ghost" data-duplicate="${esc(s.id)}">Duplicate</button></td></tr>`
              )
              .join('')}
          </tbody></table></div>
        <button type="button" class="btn btn-sm" id="new-template">+ New template</button>
        <p class="muted small">Everyone picks a template on the Export page. The built-in one always includes every field.</p>
      </section>
      ${t ? editor(t) : ''}`;
  };

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Excel export templates, e.g. the exact columns the department's purchasing form wants.</p></div></div>
    ${adminTabs('exports')}
    <div id="exports-errors"></div>
    <div id="exports-body"></div>
    <div class="form-actions sticky-actions">
      <span class="muted small" id="exports-dirty" hidden>Unsaved changes</span>
      <button type="button" class="btn btn-primary" id="exports-save" disabled>Save templates</button>
    </div>`;

  const markDirty = () => {
    dirty = true;
    el.querySelector('#exports-save').disabled = false;
    el.querySelector('#exports-dirty').hidden = false;
  };

  el.addEventListener('input', (e) => {
    const t = current();
    if (!t) return;
    if (e.target.dataset.t === 'name' || e.target.dataset.t === 'fileName') t[e.target.dataset.t] = e.target.value;
    else if (e.target.dataset.header) t.headers[e.target.dataset.header] = e.target.value;
    else return;
    markDirty();
  });

  el.addEventListener('change', (e) => {
    const t = current();
    if (!t) return;
    if (e.target.dataset.t === 'rowPer') t.rowPer = e.target.value;
    else if (e.target.dataset.status) {
      t.statuses = [...el.querySelectorAll('[data-status]:checked')].map((b) => b.dataset.status);
    } else if (e.target.matches('[data-add-col]') && e.target.value) t.columns.push(e.target.value);
    else if (e.target.dataset.t === 'name' || e.target.dataset.t === 'fileName') return;
    else return;
    markDirty();
    draw();
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const t = current();
    const li = btn.closest('li[data-col]');
    if (btn.id === 'new-template') {
      const n = { id: newId(), name: 'New template', rowPer: 'item', columns: ['id', 'request:title', 'item:item_name', 'item:quantity', 'item:unit_price', 'itemTotal'], statuses: [], headers: {}, fileName: '' };
      saved.push(n);
      selected = n.id;
    } else if (btn.dataset.duplicate) {
      const src = btn.dataset.duplicate === 'full' ? builtIn : saved.find((s) => s.id === btn.dataset.duplicate);
      const copy = { ...structuredClone({ ...src, builtIn: undefined }), id: newId(), name: `${src.name} (copy)`, headers: { ...(src.headers || {}) } };
      delete copy.builtIn;
      saved.push(copy);
      selected = copy.id;
    } else if (btn.dataset.select) selected = btn.dataset.select;
    else if (btn.hasAttribute('data-delete-template') && t) {
      if (!confirm(`Delete the template "${t.name}"?`)) return;
      saved.splice(saved.indexOf(t), 1);
      selected = saved[0]?.id || null;
    } else if (li && btn.dataset.colMove && t) {
      const i = t.columns.indexOf(li.dataset.col);
      move(t.columns, i, Number(btn.dataset.colMove));
    } else if (li && btn.hasAttribute('data-col-remove') && t) {
      t.columns = t.columns.filter((k) => k !== li.dataset.col);
    } else if (btn.hasAttribute('data-add-all') && t) {
      for (const c of catalog) if (!t.columns.includes(c.key) && (t.rowPer === 'item' || !c.perItem)) t.columns.push(c.key);
    } else if (btn.id === 'exports-save') {
      const problems = saved.flatMap((s) => [!s.name.trim() && 'Every template needs a name.', !s.columns.length && `"${s.name}" has no columns.`].filter(Boolean));
      if (problems.length) {
        el.querySelector('#exports-errors').innerHTML = errorBox(Object.assign(new Error('Please fix the following:'), { details: [...new Set(problems)] }));
        return;
      }
      btn.disabled = true;
      try {
        // Only keep headings that were actually changed.
        const templates = saved.map((s) => ({
          ...s,
          name: s.name.trim(),
          headers: Object.fromEntries(Object.entries(s.headers).filter(([k, v]) => v.trim() && v.trim() !== byKey.get(k)?.header && s.columns.includes(k))),
        }));
        await api.updateSettings('exports', { templates });
        await reloadConfig();
        dirty = false;
        setFlash('Export templates saved.');
        await rerender();
      } catch (err) {
        el.querySelector('#exports-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
      return;
    } else return;
    markDirty();
    draw();
  });

  guardUnsaved(el, () => dirty);
  draw();
}

// ---- Text & banner ------------------------------------------------------------------

/** Pages whose intro line can be replaced. */
export const INTRO_PAGES = [
  ['requests', 'Requests', 'Purchase requests for the current season.'],
  ['new', 'New Request', 'Fill in the request, add one row per item, then submit for Chief Engineer approval.'],
  ['approvals', 'Approvals', 'How many requests are waiting, and their total.'],
  ['treasurer', 'Treasurer', 'How many requests are waiting to be ordered or delivered.'],
  ['archive', 'Archive', 'Orders from past seasons.'],
  ['export', 'Export', 'Download requests and items as an Excel workbook.'],
];

export async function renderTextBanner(el, { config, rerender, reloadConfig }) {
  const a = config.appearance || {};
  const ann = a.announcement || {};

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Messages and wording people see around the site.</p></div></div>
    ${adminTabs('text')}
    <div id="text-errors"></div>
    <form id="text-form" novalidate>
      <section class="card">
        <h2>Announcement banner</h2>
        <p class="muted small">Shown at the top of every page for signed-in people, e.g. "No orders during finals week".</p>
        <div class="field"><label for="ann-text">Message <span class="muted">(leave empty for no banner)</span></label>
          <textarea id="ann-text" name="annText" rows="2" maxlength="500">${esc(ann.text || '')}</textarea></div>
        <div class="form-grid">
          <div class="field"><label for="ann-tone">Style</label>
            <select id="ann-tone" name="annTone">${[['info', 'Blue (information)'], ['warning', 'Amber (heads up)'], ['success', 'Green (good news)'], ['error', 'Red (urgent)']]
              .map(([k, l]) => `<option value="${k}" ${ann.tone === k ? 'selected' : ''}>${l}</option>`)
              .join('')}</select></div>
          <div class="field"><label for="ann-until">Hide automatically after <span class="muted">(optional)</span></label>
            <input id="ann-until" name="annUntil" type="date" value="${esc(ann.until || '')}"></div>
        </div>
      </section>

      <section class="card">
        <h2>Sign-in page message</h2>
        <div class="field"><label for="signin-msg">Shown under the sign-in box <span class="muted">(optional)</span></label>
          <textarea id="signin-msg" name="signIn" rows="2" maxlength="500" placeholder="e.g. Use your @ufl.edu email. Questions? Ask the Treasurer.">${esc(a.signInMessage || '')}</textarea></div>
      </section>

      <section class="card">
        <h2>Page intros</h2>
        <p class="muted small">The line under each page's title. Leave empty to keep the standard text.</p>
        <div class="form-grid">${INTRO_PAGES.map(
          ([k, label, hint]) => `<div class="field span-2"><label for="intro-${k}">${esc(label)}</label>
            <input id="intro-${k}" type="text" data-intro="${k}" value="${esc(a.intros?.[k] || '')}" placeholder="${esc(hint)}" maxlength="200"></div>`
        ).join('')}</div>
      </section>

      <section class="card">
        <h2>Help page</h2>
        <p class="muted small">When filled in, a <strong>Help</strong> tab appears for everyone. Formatting: a line starting with <code>#</code> is a heading,
          <code>- </code> starts a bullet, <code>**bold**</code>, and links as <code>[text](https://…)</code>. Leave a blank line between paragraphs.</p>
        <div class="two-col">
          <div class="field"><label for="help-text">Help text</label>
            <textarea id="help-text" name="help" rows="14" maxlength="20000">${esc(a.helpText || '')}</textarea></div>
          <div class="field"><label>Preview</label><div class="help-preview card" id="help-preview"></div></div>
        </div>
      </section>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save text & banner</button>
      </div>
    </form>`;

  const form = el.querySelector('#text-form');
  const preview = () => (el.querySelector('#help-preview').innerHTML = renderRichText(form.help.value) || '<p class="muted">Nothing yet.</p>');
  form.help.addEventListener('input', preview);
  preview();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const intros = Object.fromEntries([...form.querySelectorAll('[data-intro]')].map((i) => [i.dataset.intro, i.value.trim()]).filter(([, v]) => v));
    const value = {
      ...(config.appearance || {}),
      announcement: form.annText.value.trim() ? { text: form.annText.value.trim(), tone: form.annTone.value, until: form.annUntil.value || '' } : null,
      signInMessage: form.signIn.value.trim(),
      intros,
      helpText: form.help.value.trim(),
    };
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api.updateSettings('appearance', value);
      await reloadConfig();
      setFlash('Text & banner saved.');
      await rerender();
    } catch (err) {
      el.querySelector('#text-errors').innerHTML = errorBox(err);
      button.disabled = false;
    }
  });
}
