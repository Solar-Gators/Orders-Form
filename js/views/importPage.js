/**
 * Admin → Import: bring old Excel order sheets into the app.
 *   • Past season  → Archive (every column kept as-is, searchable)
 *   • This season  → real requests with their approval / order history
 * Nothing is saved until the lead reviews the preview and clicks Import.
 */
import { api } from '../api.js';
import { esc, fmtMoney, fmtDate, fmtDateTime, statusBadge, errorBox, setFlash, takeFlash } from '../ui.js';
import { itemFields, requestFields, fieldOptions } from '../formFields.js';
import { readWorkbook, pickSheet, guessSeason, toArchiveRows, toRequests, guessSubsystem, detectColumns } from '../sheetImport.js';
import { adminTabs } from './admin.js';

// Kept between re-renders of this page.
const state = { file: null, sheets: null, sheetName: '', mode: 'archive', season: '', subsystemMap: {}, target: '' };

/**
 * Request fields the sheet's Subteam column can go into: the built-in Subsystem
 * and any dropdown you've added (e.g. Cost center).
 */
function subteamTargets(config) {
  return requestFields(config).filter((f) => f.type !== 'section' && (f.key === 'subsystem' || (!f.builtin && f.type === 'select')));
}
/** Best default: a visible dropdown that looks like a team / cost center, else Subsystem (if shown). */
function defaultTarget(config) {
  const targets = subteamTargets(config);
  const shown = targets.filter((f) => !f.hidden);
  const teamLike = shown.find((f) => !f.builtin && /cost\s*cent|team|group|department/i.test(f.label));
  return (teamLike || shown.find((f) => f.key === 'subsystem') || shown[0] || targets[0])?.key || 'subsystem';
}

export async function renderImport(el, { config, rerender, reloadConfig }) {
  const imports = await api.listArchiveImports();

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Bring old Excel order sheets into the app. Nothing is saved until you click Import.</p></div></div>
    ${adminTabs('import')}
    <div id="import-errors"></div>
    <section class="card">
      <h2>1. Choose a spreadsheet</h2>
      <input type="file" id="file" accept=".xlsx" aria-label="Excel file">
      ${state.file ? `<p class="muted small">Loaded <strong>${esc(state.file.name)}</strong>.</p>` : '<p class="muted small">.xlsx files only. The file is read in your browser.</p>'}
      <div id="setup"></div>
    </section>
    <div id="preview"></div>
    <section class="card">
      <h2>Archived seasons</h2>
      ${
        imports.length
          ? `<div class="table-wrap flat"><table class="table">
              <thead><tr><th>Season</th><th>File</th><th>Sheet</th><th class="num">Rows</th><th>Imported</th><th></th></tr></thead>
              <tbody>${imports
                .map(
                  (i) => `<tr><td><strong>${esc(i.season)}</strong></td><td>${esc(i.source_file)}</td><td>${esc(i.sheet)}</td>
                    <td class="num">${i.row_count}</td><td>${fmtDateTime(i.imported_at)}</td>
                    <td><button type="button" class="btn btn-sm btn-danger" data-delete="${esc(i.id)}" data-label="${esc(`${i.season} (${i.source_file})`)}">Delete</button></td></tr>`
                )
                .join('')}</tbody></table></div>`
          : '<p class="muted">None yet.</p>'
      }
    </section>`;

  const errors = el.querySelector('#import-errors');
  const showError = (err) => {
    errors.innerHTML = errorBox(err);
    errors.scrollIntoView({ behavior: 'smooth' });
  };

  el.querySelector('#file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    errors.innerHTML = '';
    el.querySelector('#setup').innerHTML = '<p class="muted">Reading…</p>';
    try {
      state.file = file;
      state.sheets = await readWorkbook(file);
      state.sheetName = pickSheet(state.sheets)?.name || '';
      state.season = guessSeason(file.name);
      state.mode = state.season && state.season === config.season ? 'requests' : 'archive';
      state.subsystemMap = {};
      drawSetup();
    } catch (err) {
      el.querySelector('#setup').innerHTML = '';
      showError(new Error(`Couldn't read that file: ${err.message}`));
    }
  });

  el.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delete]');
    if (!del) return;
    if (!confirm(`Delete the archived season ${del.dataset.label}? Its rows will be removed from the Archive.`)) return;
    try {
      await api.deleteArchiveImport(del.dataset.delete);
      setFlash('Archived season deleted.');
      await rerender();
    } catch (err) {
      showError(err);
    }
  });

  // ---- step 2: sheet, destination, season -----------------------------------------

  function drawSetup() {
    const setup = el.querySelector('#setup');
    if (!state.sheets) return;
    const sheet = state.sheets.find((s) => s.name === state.sheetName);
    setup.innerHTML = `
      <div class="form-grid import-setup">
        <div class="field">
          <label for="sheet">Sheet (tab)</label>
          <select id="sheet">${state.sheets
            .map((s) => `<option value="${esc(s.name)}" ${s.name === state.sheetName ? 'selected' : ''}>${esc(s.name)} — ${s.rows.length} rows</option>`)
            .join('')}</select>
        </div>
        <div class="field span-2">
          <label>Import into</label>
          <div class="radio-row">
            <label><input type="radio" name="mode" value="archive" ${state.mode === 'archive' ? 'checked' : ''}> Archive (past season)</label>
            <label><input type="radio" name="mode" value="requests" ${state.mode === 'requests' ? 'checked' : ''}> This season's requests (${esc(config.season)})</label>
          </div>
        </div>
        <div class="field" ${state.mode === 'archive' ? '' : 'hidden'}>
          <label for="season">Season</label>
          <input id="season" type="text" value="${esc(state.season)}" placeholder="2024-2025">
        </div>
      </div>
      ${sheet && sheet.rows.length === 0 ? '<div class="alert alert-info">This sheet has no order rows.</div>' : ''}`;

    setup.querySelector('#sheet').addEventListener('change', (e) => {
      state.sheetName = e.target.value;
      state.subsystemMap = {};
      drawSetup();
    });
    setup.querySelectorAll('input[name="mode"]').forEach((r) =>
      r.addEventListener('change', (e) => {
        state.mode = e.target.value;
        drawSetup();
      })
    );
    setup.querySelector('#season').addEventListener('input', (e) => {
      state.season = e.target.value.trim();
      drawPreview();
    });
    drawPreview();
  }

  // ---- step 3: preview + import ------------------------------------------------------

  function drawPreview() {
    const box = el.querySelector('#preview');
    const sheet = state.sheets?.find((s) => s.name === state.sheetName);
    if (!sheet || !sheet.rows.length) {
      box.innerHTML = '';
      return;
    }
    if (state.mode === 'archive') drawArchivePreview(box, sheet);
    else drawRequestsPreview(box, sheet);
  }

  function drawArchivePreview(box, sheet) {
    const rows = toArchiveRows(sheet);
    const detected = detectColumns(sheet.columns);
    const dup = imports.find((i) => i.season === state.season && i.source_file === state.file.name);
    const total = rows.reduce((s, r) => s + (r.cost || 0), 0);
    box.innerHTML = `
      <section class="card">
        <h2>2. Preview — ${rows.length} rows into the Archive</h2>
        <p>All <strong>${sheet.columns.length} columns</strong> are kept exactly as in the sheet:
          ${sheet.columns.map((c) => `<span class="chip">${esc(c)}</span>`).join(' ')}</p>
        <p class="muted small">Recognised for search and filters: ${Object.entries(detected)
          .filter(([, c]) => c)
          .map(([k]) => esc(k))
          .join(', ')}. Gross cost total: ${fmtMoney(total)}.</p>
        ${dup ? `<div class="alert alert-warning">${esc(state.file.name)} was already imported for ${esc(state.season)}. Importing again will add duplicate rows — delete the old import below first.</div>` : ''}
        <div class="table-wrap flat preview-table"><table class="table">
          <thead><tr><th>Row</th>${sheet.columns.map((c) => `<th title="${esc(c)}">${esc(c.length > 28 ? c.slice(0, 26) + '…' : c)}</th>`).join('')}</tr></thead>
          <tbody>${sheet.rows
            .slice(0, 8)
            .map((r) => `<tr><td class="muted">${r.row_number}</td>${sheet.columns.map((c) => `<td>${esc((r.values[c] || '').slice(0, 60))}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>
        <p class="muted small">Showing the first 8 of ${rows.length} rows.</p>
        <div class="form-actions">
          <button type="button" class="btn btn-primary" id="do-import" ${state.season ? '' : 'disabled'}>
            Import ${rows.length} rows into ${esc(state.season || '…')}
          </button>
        </div>
      </section>`;

    box.querySelector('#do-import').addEventListener('click', async (e) => {
      if (!/^\S.*$/.test(state.season)) return showError(new Error('Enter the season, e.g. 2024-2025.'));
      e.target.disabled = true;
      e.target.textContent = 'Importing…';
      try {
        await api.importArchive({ season: state.season, sourceFile: state.file.name, sheet: sheet.name, columns: sheet.columns, rows });
        setFlash(`Imported ${rows.length} rows into the ${state.season} archive.`);
        Object.assign(state, { file: null, sheets: null });
        await rerender();
      } catch (err) {
        showError(err);
        e.target.disabled = false;
        e.target.textContent = `Import ${rows.length} rows into ${state.season}`;
      }
    });
  }

  function drawRequestsPreview(box, sheet) {
    const fields = itemFields(config);
    const targets = subteamTargets(config);
    if (!targets.some((t) => t.key === state.target)) state.target = defaultTarget(config);
    const target = targets.find((t) => t.key === state.target) || { key: 'subsystem', label: 'Subsystem', builtin: true };
    const choices = target.key === 'subsystem' ? config.subsystems : fieldOptions(target, config);
    const first = toRequests(sheet, { config, itemFields: fields });
    // Default mapping for old subteam names: best guess, otherwise keep the name.
    for (const s of first.subteams) {
      if (!(s in state.subsystemMap)) state.subsystemMap[s] = guessSubsystem(s, choices) || s;
    }
    const built = toRequests(sheet, { config, itemFields: fields, subsystemMap: state.subsystemMap });
    const { newItemFields } = built;
    // Subteam → the chosen field (custom fields live in the request's data).
    const requests = built.requests.map((r) =>
      target.key === 'subsystem' ? r : { ...r, subsystem: '', data: { ...(r.data || {}), ...(r.subsystem ? { [target.key]: r.subsystem } : {}) }, mapped: r.subsystem }
    );
    const valueOf = (r) => (target.key === 'subsystem' ? r.subsystem : r.mapped);
    const unknown = first.subteams.filter((s) => !choices.includes(s));
    const added = [...new Set(Object.values(state.subsystemMap).filter((v) => v && !choices.includes(v)))];
    const total = requests.reduce((s, r) => s + r.total, 0);
    const counts = requests.reduce((c, r) => ((c[r.status] = (c[r.status] || 0) + 1), c), {});

    box.innerHTML = `
      <section class="card">
        <h2>2. Preview — ${sheet.rows.length} rows → ${requests.length} requests</h2>
        <p>Rows with the same requester, date, subteam, ticket #, and status become one request.
          ${Object.entries(counts).map(([s, n]) => `${n} ${statusBadge(s)}`).join(' ')} · ${fmtMoney(total)} total.</p>
        <ul class="small import-notes">
          <li><strong>CE Approval</strong> becomes the approval, <strong>Order Status</strong> and <strong>Ticket Number</strong> become the order history. The Treasurer can keep marking deliveries.</li>
          <li><strong>Gross Cost</strong> is the line total, so unit price = cost ÷ quantity. Quantities like "1 (Pack of 50)" keep their original text in Notes.</li>
          ${newItemFields.length ? `<li>These columns will be added as item fields (edit them later in Form fields): ${newItemFields.map((f) => `<span class="chip">${esc(f.label)}</span>`).join(' ')}</li>` : ''}
          <li>Imported requests are linked to people's accounts by the Requester name when it matches someone (leads can fix it on the request's page).</li>
        </ul>
        <div class="field import-target">
          <label for="import-target">Put the sheet's Subteam column into</label>
          <select id="import-target">${targets
            .map((t) => `<option value="${esc(t.key)}" ${t.key === target.key ? 'selected' : ''}>${esc(t.label)}${t.hidden ? ' (hidden on the form)' : ''}</option>`)
            .join('')}</select>
          <div class="hint">Pick the dropdown your team uses now, e.g. Cost center.</div>
        </div>
        ${
          unknown.length
            ? `<h3 class="section-title">Subteam names</h3>
               <p class="muted small">These names aren't in your ${esc(target.label)} list. Match each one to an option, or keep it as a new option.</p>
               <div class="map-grid">${unknown
                 .map(
                   (s) => `<label>${esc(s)}</label>
                     <select data-map="${esc(s)}">
                       <option value="${esc(s)}" ${state.subsystemMap[s] === s ? 'selected' : ''}>Keep “${esc(s)}” (add to list)</option>
                       ${choices.map((c) => `<option value="${esc(c)}" ${state.subsystemMap[s] === c ? 'selected' : ''}>→ ${esc(c)}</option>`).join('')}
                     </select>`
                 )
                 .join('')}</div>
               ${added.length ? `<p class="muted small">Will be added to the ${esc(target.label)} list: ${added.map(esc).join(', ')}.</p>` : ''}`
            : ''
        }
        <div class="table-wrap flat preview-table"><table class="table">
          <thead><tr><th>Date</th><th>Requester</th><th>${esc(target.label)}</th><th>Title</th><th class="num">Items</th><th class="num">Total</th><th>Status</th><th>Approver</th><th>Ticket</th></tr></thead>
          <tbody>${requests
            .map(
              (r) => `<tr><td class="nowrap">${fmtDate(r.date)}</td><td>${esc(r.requester)}</td><td>${esc(valueOf(r))}</td>
                <td>${esc(r.title)}</td><td class="num">${r.items.length}</td><td class="num">${fmtMoney(r.total)}</td>
                <td>${statusBadge(r.status)}</td><td>${esc(r.approver || '—')}</td><td>${esc(r.ticket || '—')}</td></tr>`
            )
            .join('')}</tbody></table></div>
        <div class="alert alert-warning small">Import this sheet only once — importing it again creates duplicate requests.</div>
        <div class="form-actions">
          <button type="button" class="btn btn-primary" id="do-import">Import ${requests.length} requests into ${esc(config.season)}</button>
        </div>
      </section>`;

    box.querySelector('#import-target').addEventListener('change', (e) => {
      state.target = e.target.value;
      state.subsystemMap = {}; // different list: guess the matches again
      drawPreview();
    });

    box.querySelectorAll('select[data-map]').forEach((sel) =>
      sel.addEventListener('change', () => {
        state.subsystemMap[sel.dataset.map] = sel.value;
        drawPreview();
      })
    );

    box.querySelector('#do-import').addEventListener('click', async (e) => {
      if (!confirm(`Create ${requests.length} requests from ${state.file.name}?`)) return;
      e.target.disabled = true;
      e.target.textContent = 'Importing…';
      try {
        // Make sure new dropdown options and item fields exist before the requests use them.
        if (added.length || newItemFields.length) {
          const form = (await api.getSettings()).form || {};
          const merge = (list) => [...(list || []), ...added.filter((a) => !(list || []).includes(a))];
          await api.updateSettings('form', {
            ...form,
            ...(target.key === 'subsystem'
              ? { subsystems: merge(form.subsystems) }
              : { requestFields: requestFields(form).map((f) => (f.key === target.key ? { ...f, options: merge(f.options) } : f)) }),
            itemFields: [...itemFields(form), ...newItemFields],
          });
        }
        // One call, so the database imports all of them or none (no half-imported sheets).
        const created = await api.importRequests(requests.map(({ total, subteam, mapped, ...r }) => r));
        await reloadConfig();
        setFlash(`Imported ${created} requests from ${state.file.name}.`);
        Object.assign(state, { file: null, sheets: null, subsystemMap: {}, target: '' });
        location.hash = '#/requests';
      } catch (err) {
        showError(err);
        e.target.disabled = false;
        e.target.textContent = `Import ${requests.length} requests into ${config.season}`;
      }
    });
  }

  if (state.sheets) drawSetup();
}
