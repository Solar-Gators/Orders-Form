/**
 * Admin pages for "Workflow, budgets & notifications" (permission workflow.edit):
 *   #/admin/workflow       — approval rules (who approves what); budgets are on the Treasurer page
 *   #/admin/notifications  — email / Teams messages: on/off, per event, wording, log
 * The database enforces both (migration 010); the send-notifications Edge
 * Function delivers the messages (docs/MAINTAINING.md).
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, errorBox, setFlash, takeFlash, fmtMoney, fmtDateTime } from '../ui.js';
import { requestFields, fieldOptions, CONDITION_OPS, describeCondition } from '../formFields.js';
import { RULE_TYPES, EVENTS, PLACEHOLDERS, workflowSettings } from '../workflow.js';
import { adminTabs } from './admin.js';
import { guardLeaving } from '../leaveGuard.js';

const move = (list, i, d) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
};

/** Warn before leaving a page with unsaved edits (switching pages or closing the tab). */
const guardUnsaved = (el, isDirty) => guardLeaving(el, isDirty);

// ---- Workflow: approval rules + budgets ----------------------------------------------------

export async function renderWorkflow(el, { config, rerender, reloadConfig }) {
  const [people, rolePerms] = await Promise.all([api.listProfiles(), api.listRolePermissions()]);
  const reviewerRoles = new Set(rolePerms.filter((rp) => rp.permission === 'request.review').map((rp) => rp.role));
  const isReviewer = (p) => (p.roles || []).some((r) => reviewerRoles.has(r));
  // Chief Engineers first, then everyone else.
  const everyone = [...people].sort((a, b) => isReviewer(b) - isReviewer(a) || (a.full_name || a.email).localeCompare(b.full_name || b.email));
  const nameOf = (id) => {
    const p = people.find((x) => x.id === id);
    return p ? p.full_name || p.email : 'Someone who left';
  };

  const fields = requestFields(config).filter((f) => f.type !== 'section' && !f.hidden);
  const optionsOf = (f) => (f?.type === 'yesno' ? ['Yes', 'No'] : f ? fieldOptions(f, config) : []);
  // Budgets: a dropdown like Cost center or Subsystem (not Priority or yes/no answers).
  // Rule conditions: dropdowns and yes/no answers (plus any field a saved rule already uses).
  const ruleFields = (current) => fields.filter((f) => ['select', 'yesno'].includes(f.type) || f.key === current);

  const saved = workflowSettings(config);
  const state = structuredClone({ rules: saved.rules });
  let dirty = false;
  let open = null; // index of the rule being edited

  const conditionText = (r) => {
    const parts = [];
    if (r.when?.field) parts.push(describeCondition(r.when, fields));
    if (r.when?.minTotal) parts.push(`total ≥ ${fmtMoney(Number(r.when.minTotal))}`);
    if (r.when?.maxTotal) parts.push(`total < ${fmtMoney(Number(r.when.maxTotal))}`);
    return parts.length ? `When ${parts.join(' and ')}` : 'Every request';
  };
  const actionText = (r) => {
    const t = r.then?.type || 'any';
    if (t === 'auto') return 'approve automatically';
    if (t === 'any') return 'any Chief Engineer approves';
    const names = (r.then.people || []).map(nameOf);
    if (!names.length) return 'specific people (none picked yet → any Chief Engineer)';
    return r.then.needAll && names.length > 1 ? `all of ${names.join(', ')} approve` : `${names.join(' or ')} approves`;
  };

  const ruleEditor = (r, i) => {
    const w = r.when || {};
    const f = fields.find((x) => x.key === w.field);
    const op = CONDITION_OPS.find((o) => o.key === w.op) || CONDITION_OPS[0];
    const values = Array.isArray(w.value) ? w.value : w.value !== undefined && w.value !== '' ? [w.value] : [];
    const opts = optionsOf(f);
    const valueInput = !w.field || !op.needsValue
      ? ''
      : opts.length
        ? op.many
          ? `<span class="cond-multi">${opts.map((o) => `<label class="role-chip ${values.includes(o) ? 'on' : ''}"><input type="checkbox" data-w="multi" value="${esc(o)}" ${values.includes(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</span>`
          : `<select data-w="value" aria-label="Value"><option value="">Choose…</option>${opts.map((o) => `<option value="${esc(o)}" ${values[0] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input type="text" data-w="value" aria-label="Value" value="${esc(values.join(', '))}" placeholder="${op.many ? 'Values, separated by commas' : 'Value'}">`;
    const type = r.then?.type || 'any';
    const picked = r.then?.people || [];
    return `<div class="rules-panel">
      <div class="rule"><strong>Name</strong><input type="text" data-w="name" aria-label="Rule name" value="${esc(r.name || '')}" placeholder="e.g. Battery orders" maxlength="60"></div>
      <div class="rule"><strong>Applies when</strong>
        <select data-w="field" aria-label="Field to check"><option value="">Any request</option>${ruleFields(w.field).map((x) => `<option value="${esc(x.key)}" ${x.key === w.field ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        ${w.field ? `<select data-w="op">${CONDITION_OPS.map((o) => `<option value="${o.key}" ${o.key === op.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${valueInput}` : ''}
      </div>
      <div class="rule"><strong>and the total is</strong>
        <input type="number" min="0" step="0.01" data-w="minTotal" aria-label="Total at least" value="${esc(w.minTotal ?? '')}" placeholder="at least $"> <span class="muted">and under</span>
        <input type="number" min="0" step="0.01" data-w="maxTotal" aria-label="Total under" value="${esc(w.maxTotal ?? '')}" placeholder="any $">
        <span class="hint">Totals include shipping. Leave blank for any amount.</span></div>
      <div class="rule"><strong>Then</strong>
        <select data-w="type">${RULE_TYPES.map((t) => `<option value="${t.key}" ${t.key === type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        <span class="hint">${esc(RULE_TYPES.find((t) => t.key === type).hint)}</span></div>
      ${
        type === 'people'
          ? `<div class="rule"><strong>Who</strong><span class="role-chips">${everyone
              .map((p) => `<label class="role-chip ${picked.includes(p.id) ? 'on' : ''}"><input type="checkbox" data-w="person" value="${p.id}" ${picked.includes(p.id) ? 'checked' : ''}>${esc(p.full_name || p.email)}${isReviewer(p) ? ' <span class="muted small">CE</span>' : ''}</label>`)
              .join('')}</span></div>
            <div class="rule"><strong>Needs</strong>
              <label class="role-chip ${r.then.needAll ? '' : 'on'}"><input type="radio" name="need-${i}" data-w="needAll" value="" ${r.then.needAll ? '' : 'checked'}>Any one of them</label>
              <label class="role-chip ${r.then.needAll ? 'on' : ''}"><input type="radio" name="need-${i}" data-w="needAll" value="1" ${r.then.needAll ? 'checked' : ''}>All of them (each must approve)</label></div>`
          : ''
      }
    </div>`;
  };

  const rulesList = () =>
    state.rules.length
      ? `<ol class="workflow-rules">${state.rules
          .map(
            (r, i) => `<li class="${r.disabled ? 'is-off' : ''}" data-i="${i}">
              <div class="workflow-rule-head">
                <span class="rule-order">${i + 1}</span>
                <div class="rule-text"><strong>${esc(r.name || `Rule ${i + 1}`)}</strong>
                  <span class="muted small">${esc(conditionText(r))} → ${esc(actionText(r))}</span></div>
                <span class="column-actions">
                  <label class="small" title="Turn this rule off without deleting it"><input type="checkbox" data-act="toggle" ${r.disabled ? '' : 'checked'}> On</label>
                  <button type="button" class="btn btn-sm" data-act="edit">${open === i ? 'Done' : 'Edit'}</button>
                  <button type="button" class="icon-btn" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
                  <button type="button" class="icon-btn" data-act="down" aria-label="Move down" ${i === state.rules.length - 1 ? 'disabled' : ''}>↓</button>
                  <button type="button" class="icon-btn" data-act="delete" aria-label="Delete rule">✕</button>
                </span>
              </div>
              ${open === i ? ruleEditor(r, i) : ''}
            </li>`
          )
          .join('')}</ol>`
      : '<p class="empty small">No rules: any Chief Engineer can approve any request.</p>';

  const draw = () => {
    el.querySelector('#rules').innerHTML = rulesList();
    // (Budgets are edited on the Treasurer page.)
  };

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Who approves what, and how much each group can spend.</p></div></div>
    ${adminTabs('workflow')}
    <div id="wf-errors"></div>
    <section class="card">
      <div class="card-head"><h2>Approval rules</h2><button type="button" class="btn btn-sm" id="add-rule">+ Add rule</button></div>
      <p class="muted small">When a request is submitted, the rules are checked from the top; the <strong>first one that matches</strong> decides who approves it.
        If none match, any Chief Engineer can approve. Examples: small orders approved automatically, Battery orders go to the Battery lead, anything over $1,000 needs two CEs.</p>
      <div id="rules"></div>
    </section>
    <section class="card"><h2>Budgets</h2>
      <p class="muted small">Budgets (per Cost center, Subsystem, …) are set by the Treasurer on the <a href="#/treasurer">Treasurer page</a>.</p></section>
    <div class="form-actions sticky-actions">
      <span class="muted small" id="wf-dirty" hidden>Unsaved changes</span>
      <button type="button" class="btn btn-primary" id="wf-save" disabled>Save workflow</button>
    </div>`;

  const markDirty = () => {
    dirty = true;
    el.querySelector('#wf-save').disabled = false;
    el.querySelector('#wf-dirty').hidden = false;
  };

  el.addEventListener('input', (e) => {
    const t = e.target;
    const li = t.closest('li[data-i]');
    if (li && t.dataset.w) {
      const r = state.rules[Number(li.dataset.i)];
      r.when ||= {};
      r.then ||= { type: 'any' };
      const k = t.dataset.w;
      if (k === 'name') r.name = t.value;
      else if (k === 'minTotal' || k === 'maxTotal') r.when[k] = t.value;
      else if (k === 'value' && t.tagName === 'INPUT') {
        const op = CONDITION_OPS.find((o) => o.key === r.when.op) || CONDITION_OPS[0];
        r.when.value = op.many ? t.value.split(',').map((s) => s.trim()).filter(Boolean) : t.value;
      } else return; // selects / checkboxes are handled on change
      markDirty();
      const text = li.querySelector('.rule-text');
      text.querySelector('strong').textContent = r.name || `Rule ${Number(li.dataset.i) + 1}`;
      text.querySelector('.muted').textContent = `${conditionText(r)} → ${actionText(r)}`;
    }
  });

  el.addEventListener('change', (e) => {
    const t = e.target;
    const li = t.closest('li[data-i]');
    if (li && t.dataset.act === 'toggle') {
      state.rules[Number(li.dataset.i)].disabled = !t.checked;
      markDirty();
      return draw();
    }
    if (li && t.dataset.w) {
      const r = state.rules[Number(li.dataset.i)];
      const k = t.dataset.w;
      if (k === 'field') r.when = { ...r.when, field: t.value, op: 'equals', value: '' };
      else if (k === 'op') {
        const op = CONDITION_OPS.find((o) => o.key === t.value);
        r.when.op = t.value;
        r.when.value = op.many ? [] : '';
      } else if (k === 'value' && t.tagName === 'SELECT') r.when.value = t.value;
      else if (k === 'multi') r.when.value = [...li.querySelectorAll('[data-w="multi"]:checked')].map((x) => x.value);
      else if (k === 'type') r.then = { type: t.value, people: r.then?.people || [], needAll: !!r.then?.needAll };
      else if (k === 'person') r.then.people = [...li.querySelectorAll('[data-w="person"]:checked')].map((x) => x.value);
      else if (k === 'needAll') r.then.needAll = t.value === '1';
      else return;
      markDirty();
      return draw();
    }
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('li[data-i]');
    const i = li ? Number(li.dataset.i) : -1;
    const act = btn.dataset.act;
    if (btn.id === 'add-rule') {
      state.rules.push({ name: '', when: {}, then: { type: 'people', people: [], needAll: false } });
      open = state.rules.length - 1;
      markDirty();
      draw();
    } else if (act === 'edit') {
      open = open === i ? null : i;
      draw();
    } else if (act === 'up' || act === 'down') {
      move(state.rules, i, act === 'up' ? -1 : 1);
      open = null;
      markDirty();
      draw();
    } else if (act === 'delete') {
      if (!confirm(`Delete "${state.rules[i].name || `Rule ${i + 1}`}"?`)) return;
      state.rules.splice(i, 1);
      open = null;
      markDirty();
      draw();
    } else if (btn.id === 'wf-save') {
      btn.disabled = true;
      try {
        // Keep the budgets as the Treasurer last saved them (they may have changed since this page opened).
        const latest = (await api.getSettings()).workflow || {};
        await api.updateSettings('workflow', { ...latest, rules: state.rules });
        await reloadConfig();
        dirty = false;
        setFlash('Workflow saved. New rules apply to requests submitted from now on.');
        await rerender();
      } catch (err) {
        el.querySelector('#wf-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
  });

  guardUnsaved(el, () => dirty);
  draw();
}

// ---- Notifications ---------------------------------------------------------------------------

/** Same filling rules as the Edge Function (lines whose placeholders are all empty are dropped). */
function fill(template, values) {
  return String(template || '')
    .split('\n')
    .filter((line) => {
      const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k in values);
      return !keys.length || keys.some((k) => values[k] !== '');
    })
    .map((line) => line.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m)))
    .join('\n')
    .trim();
}

const SAMPLE = {
  request_number: 'SG26-014', title: 'Steering hardware', requester: 'Austin Stang', first_name: 'Austin',
  total: '$123.45', vendor: 'McMaster-Carr', approver: 'Griffin York', comment: 'Looks good', ticket: 'PO-1234',
  status: 'Approved', rule: 'Battery orders', link: '…/#/requests/SG26-014',
};

const STATUS_TONE = { sent: 'tone-green', pending: 'tone-amber', sending: 'tone-blue', failed: 'tone-red', cancelled: 'tone-gray' };

export async function renderNotifications(el, { config, rerender, reloadConfig }) {
  const saved = config.notifications || {};
  const state = {
    enabled: !!saved.enabled,
    siteUrl: saved.siteUrl || location.origin + location.pathname,
    approvalDelayMinutes: saved.approvalDelayMinutes ?? 30,
    events: structuredClone(saved.events || {}),
    templates: structuredClone(saved.templates || {}),
  };
  let dirty = false;
  let editing = null;
  let log = [];
  let logError = null;
  try {
    log = await api.listNotifications();
  } catch (err) {
    logError = err;
  }

  const eventRows = () =>
    EVENTS.map((ev) => {
      const on = state.events[ev.key] || {};
      const t = state.templates[ev.key] || {};
      return `<tr data-ev="${ev.key}">
        <td><strong>${esc(ev.label)}</strong><div class="muted small">${esc(ev.who)}</div></td>
        <td class="center"><input type="checkbox" data-ch="email" aria-label="Email for ${esc(ev.label)}" ${on.email ? 'checked' : ''}></td>
        <td class="center"><input type="checkbox" data-ch="teams" aria-label="Teams for ${esc(ev.label)}" ${on.teams ? 'checked' : ''}></td>
        <td><button type="button" class="btn btn-sm" data-edit>${editing === ev.key ? 'Done' : 'Edit message'}</button></td>
      </tr>
      ${
        editing === ev.key
          ? `<tr class="rules-row"><td colspan="4"><div class="template-editor">
              <div>
                <div class="field"><label>Subject / Teams title</label><input type="text" data-t="subject" value="${esc(t.subject || '')}" maxlength="200"></div>
                <div class="field"><label>Message</label><textarea data-t="body" rows="5">${esc(t.body || '')}</textarea>
                  <div class="hint">A line whose placeholders are all empty is left out, e.g. "Comment: {comment}" when there's no comment. A button linking to the request is added automatically.</div></div>
              </div>
              <div class="template-preview"><div class="muted small">Preview</div><div id="preview">${preview(t)}</div></div>
            </div></td></tr>`
          : ''
      }`;
    }).join('');

  function preview(t) {
    return `<strong>${esc(fill(t.subject, SAMPLE).split('\n')[0] || '(no subject)')}</strong>
      ${fill(t.body, SAMPLE).split('\n').filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('')}
      <span class="btn btn-sm btn-primary" aria-hidden="true">Open SG26-014</span>`;
  }

  const logTable = () => {
    if (logError) return errorBox(logError);
    if (!log.length) return '<p class="empty small">Nothing sent yet.</p>';
    return `<div class="table-wrap flat"><table class="table notif-log stack-mobile">
      <thead><tr><th>When</th><th>Event</th><th>To</th><th>Via</th><th>Status</th><th></th></tr></thead>
      <tbody>${log
        .map(
          (m) => `<tr>
          <td class="nowrap" data-label="When">${fmtDateTime(m.created_at)}</td>
          <td data-label="Event">${esc(EVENTS.find((e) => e.key === m.event)?.label || (m.event === 'test' ? 'Test' : m.event))}${m.payload?.request_number ? ` <a class="mono small" href="#/requests/${esc(m.payload.request_number)}">${esc(m.payload.request_number)}</a>` : ''}</td>
          <td data-label="To">${esc(m.email)}</td>
          <td data-label="Via">${m.channel === 'teams' ? 'Teams' : 'Email'}</td>
          <td data-label="Status"><span class="badge ${STATUS_TONE[m.status] || ''}">${esc(m.status)}</span>${m.attempts > 1 ? ` <span class="muted small">${m.attempts} tries</span>` : ''}
            ${m.error ? `<div class="small error-text">${esc(m.error)}</div>` : ''}</td>
          <td>${m.status === 'failed' ? `<button type="button" class="btn btn-sm" data-retry="${m.id}">Retry</button>` : ''}</td>
        </tr>`
        )
        .join('')}</tbody></table></div>`;
  };

  const draw = () => {
    el.querySelector('#events').innerHTML = eventRows();
    el.querySelector('#log').innerHTML = logTable();
  };

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>Admin</h1>
      <p class="subtitle">Email and Microsoft Teams messages when a request needs someone or changes status.</p></div></div>
    ${adminTabs('notifications')}
    <div id="n-errors"></div>
    <div class="two-col">
      <section class="card">
        <h2>Settings</h2>
        <label class="rule-toggle"><input type="checkbox" id="n-enabled" ${state.enabled ? 'checked' : ''}>
          <span>Send notifications <span class="hint">Messages go to each person's UF email / Teams account. People can turn them off on their Account page.</span></span></label>
        <div class="field"><label for="n-site">Website address (for links)</label>
          <input type="url" id="n-site" value="${esc(state.siteUrl)}" placeholder="https://solar-gators.github.io/Orders-Form/"></div>
        <div class="field"><label for="n-delay">Wait before sending "needs your approval"</label>
          <div class="inline-input"><input type="number" id="n-delay" min="0" max="1440" step="1" value="${esc(state.approvalDelayMinutes)}"> <span class="muted">minutes</span></div>
          <div class="hint">If the request is approved, sent back, rejected or withdrawn before then (e.g. a CE approving their own order), the message isn't sent. 0 = send right away.
            Delayed messages go out the next time the sender runs, so schedule it every 5–10 minutes (docs/MAINTAINING.md → "Turn it on").</div></div>
        <p class="muted small">Sending needs a one-time setup in Supabase (email account and/or a Power Automate flow for Teams).
          ${auth.can('users.manage') ? 'The steps are in <code>docs/MAINTAINING.md</code> → "Email &amp; Teams notifications".' : 'Ask whoever maintains the site.'}</p>
      </section>
      <section class="card">
        <h2>Try it</h2>
        <p class="muted small">Sends a test message to you (${esc(auth.user.email)}) and shows any setup problem.</p>
        <div class="stack-buttons">
          <button type="button" class="btn" data-test="email">Send me a test email</button>
          <button type="button" class="btn" data-test="teams">Send me a test Teams message</button>
        </div>
        <div id="test-result"></div>
      </section>
    </div>

    <section class="card">
      <h2>Who gets what</h2>
      <div class="table-wrap flat"><table class="table events-table">
        <thead><tr><th>When a request is…</th><th class="center">Email</th><th class="center">Teams</th><th></th></tr></thead>
        <tbody id="events"></tbody>
      </table></div>
      <details class="placeholders"><summary class="small">Placeholders you can use in messages</summary>
        <dl class="meta-grid compact">${PLACEHOLDERS.map(([k, d]) => `<div><dt><code>{${k}}</code></dt><dd>${esc(d)}</dd></div>`).join('')}</dl></details>
    </section>

    <section class="card">
      <div class="card-head"><h2>Recent messages</h2><button type="button" class="btn btn-sm" id="send-now">Send waiting messages now</button></div>
      <div id="send-result"></div>
      <div id="log"></div>
    </section>

    <div class="form-actions sticky-actions">
      <span class="muted small" id="n-dirty" hidden>Unsaved changes</span>
      <button type="button" class="btn btn-primary" id="n-save" disabled>Save notifications</button>
    </div>`;

  const markDirty = () => {
    dirty = true;
    el.querySelector('#n-save').disabled = false;
    el.querySelector('#n-dirty').hidden = false;
  };
  const reloadLog = async () => {
    try {
      log = await api.listNotifications();
      logError = null;
    } catch (err) {
      logError = err;
    }
    el.querySelector('#log').innerHTML = logTable();
  };
  const sendNow = async (box) => {
    box.innerHTML = '<p class="muted small">Sending…</p>';
    try {
      const r = await api.sendNotificationsNow();
      box.innerHTML = r.failed
        ? errorBox(Object.assign(new Error(`${r.sent} sent, ${r.failed} failed.`), { details: r.errors || [] }))
        : `<div class="alert alert-success">${r.sent ? `${r.sent} message${r.sent === 1 ? '' : 's'} sent.` : 'Nothing was waiting.'}</div>`;
    } catch (err) {
      box.innerHTML = errorBox(err);
    }
    await reloadLog();
  };

  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'n-site') {
      state.siteUrl = t.value.trim();
      markDirty();
    } else if (t.id === 'n-delay') {
      state.approvalDelayMinutes = Math.max(0, Math.min(1440, Math.round(Number(t.value) || 0)));
      markDirty();
    } else if (t.dataset.t && editing) {
      state.templates[editing] = { ...(state.templates[editing] || {}), [t.dataset.t]: t.value };
      el.querySelector('#preview').innerHTML = preview(state.templates[editing]);
      markDirty();
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'n-enabled') {
      state.enabled = t.checked;
      markDirty();
    } else if (t.dataset.ch) {
      const ev = t.closest('tr[data-ev]').dataset.ev;
      state.events[ev] = { ...(state.events[ev] || {}), [t.dataset.ch]: t.checked };
      markDirty();
    }
  });
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.edit !== undefined) {
      const ev = btn.closest('tr[data-ev]').dataset.ev;
      editing = editing === ev ? null : ev;
      el.querySelector('#events').innerHTML = eventRows();
    } else if (btn.dataset.test) {
      const box = el.querySelector('#test-result');
      btn.disabled = true;
      try {
        if (dirty) throw new Error('Save your changes first.');
        await api.queueTestNotification(btn.dataset.test);
        await sendNow(box);
      } catch (err) {
        box.innerHTML = errorBox(err);
      }
      btn.disabled = false;
    } else if (btn.id === 'send-now') {
      btn.disabled = true;
      await sendNow(el.querySelector('#send-result'));
      btn.disabled = false;
    } else if (btn.dataset.retry) {
      btn.disabled = true;
      try {
        await api.retryNotification(Number(btn.dataset.retry));
        await sendNow(el.querySelector('#send-result'));
      } catch (err) {
        el.querySelector('#send-result').innerHTML = errorBox(err);
      }
    } else if (btn.id === 'n-save') {
      btn.disabled = true;
      try {
        if (state.siteUrl && !/^https?:\/\/\S+$/.test(state.siteUrl)) throw new Error('The website address must start with https://');
        await api.updateSettings('notifications', { ...saved, ...state });
        await reloadConfig();
        dirty = false;
        setFlash(state.enabled ? 'Notifications saved and turned on.' : 'Notifications saved (turned off).');
        await rerender();
      } catch (err) {
        el.querySelector('#n-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
  });

  guardUnsaved(el, () => dirty);
  draw();
}
