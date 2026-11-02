/**
 * Sponsors (migration 015): sponsorships and donations as cards on a kanban board.
 *   #/sponsors        — the board (one column per stage) or a searchable list of
 *                       every sponsor in every season, so future teams can find
 *                       similar sponsors and see what worked.
 *   #/sponsors/:id    — one card: details, "About this sponsor", "Tips for next
 *                       time", watchers, notes & history, renew for next season.
 * Moving a card to a "money received" stage adds a row to the chosen Finances
 * sheet (once). Watchers get an email / Teams message when a card moves or gets
 * a note. Viewing needs sponsors.view; changing, sponsors.edit.
 * Each card can say which car it was for (026), and old sponsor spreadsheets can be
 * imported ("Import from spreadsheet…"), so earlier cars' sponsors stay findable.
 * 027: the same sponsor across cars ("By sponsor", "This sponsor over the years"),
 * "Ask again" (past sponsors onto this season's board), the outreach tracker's
 * priority / category / date contacted, claiming a card ("I'll reach out"), and
 * renaming or merging tags.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, fmtDate, fmtDateTime, errorBox, setFlash, takeFlash, renderRichText } from '../ui.js';
import { guardLeaving, releaseGuard } from '../leaveGuard.js';
import { renderAttachments } from '../attachments.js';
import { readItemFile } from '../itemImport.js';
import { readSponsorRows, toSponsorCard, guessCar } from '../sponsorImport.js';
import { groupSponsors, sponsorKey, tagLookalikes } from '../sponsorGroups.js';

const STAGE_KINDS = [
  ['open', 'Working on it'],
  ['received', 'Money received (adds it to Finances)'],
  ['done', 'Done'],
  ['lost', 'Not happening'],
];
const DEFAULT_STAGES = [
  { key: 'prospect', label: 'Prospect', kind: 'open' },
  { key: 'contacted', label: 'Contacted', kind: 'open' },
  { key: 'talks', label: 'In talks', kind: 'open' },
  { key: 'committed', label: 'Committed', kind: 'open' },
  { key: 'received', label: 'Received', kind: 'received' },
  { key: 'thanked', label: 'Thanked', kind: 'done' },
  { key: 'declined', label: 'Not this year', kind: 'lost' },
];

/** The board's settings with defaults filled in. */
function sponsorSettings(config) {
  const s = config.sponsors || {};
  return {
    stages: Array.isArray(s.stages) && s.stages.length ? s.stages : DEFAULT_STAGES,
    kinds: Array.isArray(s.kinds) ? s.kinds : [],
    income: s.income || {},
  };
}

// Kept while moving around the app.
const view = { mode: 'board', season: '', car: '', q: '', who: '', sort: '' };

const today = () => new Date().toISOString().slice(0, 10);
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const canEdit = () => auth.can('sponsors.edit');
const hasCars = (config) => Number(config.schemaVersion) >= 26;
/** Cars named on any card, most recently added first. */
const carsOf = (cards) => [...new Set([...cards].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((c) => c.car).filter(Boolean))];
const hasOutreach = (config) => Number(config.schemaVersion) >= 27;
const daysSince = (date) => Math.round((Date.parse(today()) - Date.parse(date)) / 864e5);
/** What a card brought in: its amount once it's in a received / done stage. */
const gaveOf = (stages, c) => (['received', 'done'].includes(stages.find((s) => s.key === c.stage)?.kind) ? Number(c.amount) || 0 : 0);
/** "Flare · 2023-2024" */
const whenOf = (c) => [c.car, c.season].filter(Boolean).join(' · ') || 'Earlier';
/** The stage a card goes to once someone has emailed them. */
const contactedStage = (stages) => (stages.find((s) => s.key === 'contacted') || stages[1] || stages[0]).key;
const isOpen = (stages, card) => ['open', undefined].includes(stages.find((s) => s.key === card.stage)?.kind);

/** People who can see the board (so they can watch or lead a card). */
async function boardPeople() {
  const [people, grants] = await Promise.all([api.listProfiles(), api.listRolePermissions().catch(() => [])]);
  const roles = new Set(grants.filter((g) => ['sponsors.view', 'sponsors.edit'].includes(g.permission)).map((g) => g.role));
  return { all: people, viewers: people.filter((p) => (p.roles || []).some((r) => roles.has(r))) };
}

// ---- Board / list ----------------------------------------------------------------------

export async function renderSponsors(el, { config, rerender, reloadConfig }) {
  let cards;
  try {
    cards = await api.listSponsorCards();
  } catch {
    el.innerHTML = `<div class="page-header"><div><h1>Sponsors</h1></div></div>
      <div class="alert alert-info">The Sponsors board needs database update <code>015_sponsors.sql</code>.</div>`;
    return;
  }
  const { stages, kinds } = sponsorSettings(config);
  const [{ all: people }, fileCounts] = await Promise.all([boardPeople(), api.attachmentCounts('sponsor')]);
  const nameOf = (id) => people.find((p) => p.id === id)?.full_name || '';
  const seasons = [...new Set([config.season, ...cards.map((c) => c.season)].filter(Boolean))].sort().reverse();
  if (!view.season || (view.season !== 'all' && !seasons.includes(view.season))) view.season = config.season || seasons[0] || 'all';
  if (view.mode === 'board' && view.season === 'all') view.season = config.season;
  const me = auth.user.id;
  const cars = hasCars(config) ? carsOf(cards) : [];
  if (view.car && !cars.includes(view.car)) view.car = '';
  const outreach = hasOutreach(config);
  if (!outreach && ['sponsors', 'again'].includes(view.mode)) view.mode = 'list';
  const grouped = view.mode === 'sponsors' || view.mode === 'again';
  const groups = outreach ? groupSponsors(cards) : new Map();
  const groupOf = (c) => groups.get(sponsorKey(c)) || [c];
  const canView = canEdit() || auth.can('sponsors.view');
  const stageLabel = (k) => stages.find((s) => s.key === k)?.label || k;

  const textOf = (c) =>
    [c.name, c.kind, c.category, c.contact_name, c.contact_email, c.website, ...(c.tags || []), c.description, c.playbook, nameOf(c.owner_id), c.season, c.car]
      .join(' ')
      .toLowerCase();
  const words = () => view.q.toLowerCase().split(/\s+/).filter(Boolean);
  /** By sponsor / Ask again: a group matches when the search words are on any of its cards. */
  const groupMatches = (list) => {
    const text = list.map(textOf).join(' ');
    // (Ask again has no car filter: the car there is the one you're asking for.)
    return words().every((w) => text.includes(w)) && (!view.car || view.mode === 'again' || list.some((c) => c.car === view.car));
  };
  const matches = (c) => {
    const text = textOf(c);
    return (
      words().every((w) => text.includes(w)) &&
      (view.season === 'all' || c.season === view.season) &&
      (!view.car || c.car === view.car) &&
      (!view.who || (view.who === 'mine' ? c.owner_id === me : view.who === 'free' ? !c.owner_id && isOpen(stages, c) : c.watchers.includes(me)))
    );
  };

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Sponsors</h1>
        <p class="subtitle">Sponsorships and donations, from first contact to thank-you. Every season stays here for the next team.</p>
      </div>
      <div class="card-actions sp-actions">
        ${canEdit() ? '<button type="button" class="btn btn-primary" id="new-card">+ New sponsor</button>' : ''}
        ${canEdit() && hasCars(config) ? '<button type="button" class="btn" id="sp-import">Import from spreadsheet…</button>' : ''}
        ${canEdit() && outreach ? '<button type="button" class="btn" id="sp-tags">Tags</button>' : ''}
        ${canEdit() ? '<button type="button" class="btn" id="board-settings">Board settings</button>' : ''}
      </div>
    </div>
    <div id="settings-box"></div>
    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="View">
        <button type="button" role="tab" data-mode="board" aria-selected="${view.mode === 'board'}">Board</button>
        <button type="button" role="tab" data-mode="list" aria-selected="${view.mode === 'list'}">All sponsors</button>
        ${outreach ? `<button type="button" role="tab" data-mode="sponsors" aria-selected="${view.mode === 'sponsors'}">By sponsor</button>
        <button type="button" role="tab" data-mode="again" aria-selected="${view.mode === 'again'}">Ask again</button>` : ''}
      </div>
      <input type="search" id="sp-q" placeholder="Search names, contacts, tags, notes…" value="${esc(view.q)}" aria-label="Search sponsors">
      ${grouped ? '' : `<select id="sp-season" aria-label="Season">
        ${view.mode === 'list' ? `<option value="all" ${view.season === 'all' ? 'selected' : ''}>Every season</option>` : ''}
        ${seasons.map((s) => `<option value="${esc(s)}" ${s === view.season ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>`}
      ${cars.length && view.mode !== 'again' ? `<select id="sp-car" aria-label="Car">
        <option value="">Every car</option>
        ${cars.map((c) => `<option value="${esc(c)}" ${c === view.car ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>` : ''}
      ${grouped ? '' : `<select id="sp-who" aria-label="Whose">
        <option value="">Everyone's</option>
        <option value="mine" ${view.who === 'mine' ? 'selected' : ''}>I'm leading</option>
        <option value="watching" ${view.who === 'watching' ? 'selected' : ''}>I'm watching</option>
        ${outreach ? `<option value="free" ${view.who === 'free' ? 'selected' : ''}>Nobody's on it yet</option>` : ''}
      </select>`}
      ${outreach && view.mode === 'board' ? `<select id="sp-sort" aria-label="Order">
        <option value="">As arranged</option>
        <option value="priority" ${view.sort === 'priority' ? 'selected' : ''}>By priority</option>
      </select>` : ''}
    </div>
    <div id="sp-errors"></div>
    <div id="sp-body"></div>`;

  const errors = el.querySelector('#sp-errors');
  const body = el.querySelector('#sp-body');

  const returning = (c) => {
    const others = groupOf(c).filter((x) => x.id !== c.id);
    return others.length
      ? ` <span class="chip chip-return" title="Also on the board for ${esc(others.map(whenOf).join(', '))}">↺ Returning</span>`
      : '';
  };
  const cardHtml = (c) => {
    const due = c.follow_up && c.follow_up <= today() && isOpen(stages, c);
    const ago = c.contacted_on ? daysSince(c.contacted_on) : null;
    // Emailed two weeks ago and still waiting at Contacted: time to nudge them.
    const quiet = ago !== null && ago >= 14 && c.stage === contactedStage(stages);
    return `<article class="kcard" data-card="${esc(c.id)}" ${canEdit() ? 'draggable="true"' : ''}>
      <a class="kcard-name" href="#/sponsors/${esc(c.id)}">${c.priority ? `<span class="prio prio-${c.priority}" title="Priority ${c.priority} (1 = highest)">P${c.priority}</span> ` : ''}${esc(c.name)}</a>${returning(c)}
      ${c.category ? `<div class="muted small">${esc(c.category)}</div>` : ''}
      <div class="kcard-meta">
        ${c.kind ? `<span class="chip">${esc(c.kind.replace(/ \(.*/, ''))}</span>` : ''}
        ${c.amount !== null && c.amount !== undefined ? `<strong>${fmtMoney(c.amount)}</strong>` : ''}
      </div>
      ${(c.tags || []).length ? `<div class="kcard-tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="kcard-foot">
        ${c.owner_id ? `<span class="avatar" title="Lead: ${esc(nameOf(c.owner_id))}">${esc(initials(nameOf(c.owner_id)))}</span>` : ''}
        ${c.follow_up ? `<span class="${due ? 'late-tag' : 'muted small'}" title="Follow up">↻ ${fmtDate(c.follow_up)}</span>` : ''}
        ${ago !== null ? `<span class="${quiet ? 'late-tag' : 'muted small'}" title="Last contacted ${esc(fmtDate(c.contacted_on))}">✉ ${ago <= 0 ? 'today' : `${ago}d ago`}</span>` : ''}
        ${outreach && canView && !c.owner_id && isOpen(stages, c) ? `<button type="button" class="btn btn-sm kcard-claim" data-claim="${esc(c.id)}" title="Become the lead, so nobody else emails them too">I'll reach out</button>` : ''}
        ${c.watchers.length ? `<span class="muted small" title="${c.watchers.length} watching">👁 ${c.watchers.length}</span>` : ''}
        ${fileCounts[c.id] ? `<span class="muted small" title="${fileCounts[c.id]} file${fileCounts[c.id] === 1 ? '' : 's'} or link${fileCounts[c.id] === 1 ? '' : 's'}">📎 ${fileCounts[c.id]}</span>` : ''}
        ${canEdit() ? `<select class="kcard-move" data-move="${esc(c.id)}" aria-label="Move ${esc(c.name)} to">${stages
          .map((s) => `<option value="${esc(s.key)}" ${s.key === c.stage ? 'selected' : ''}>${esc(s.label)}</option>`)
          .join('')}</select>` : ''}
      </div>
    </article>`;
  };

  /** The outreach tracker's summary: targets, someone on it, contacted, secured. */
  const stats = (shown) => {
    const first = stages[0]?.key;
    const secured = shown.filter((c) => ['received', 'done'].includes(stages.find((s) => s.key === c.stage)?.kind) || /commit/i.test(c.stage));
    const n = (label, value, hint) => `<div class="sp-stat" title="${esc(hint)}"><strong>${value}</strong><span>${esc(label)}</span></div>`;
    return `<div class="sp-stats">
      ${n('Targets', shown.filter((c) => stages.find((s) => s.key === c.stage)?.kind !== 'lost').length, 'Sponsors on the board, not counting "not this year"')}
      ${n('Someone on it', shown.filter((c) => c.owner_id).length, 'Cards with a lead')}
      ${n('Contacted', shown.filter((c) => c.contacted_on || c.stage !== first).length, 'Past the first stage, or a date contacted')}
      ${n('Secured', secured.length, 'Committed, received or thanked')}
      ${n('Raised', fmtMoney(secured.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)), 'Amounts of the secured cards')}
    </div>`;
  };
  const byOrder = (a, b) => (view.sort === 'priority' ? (a.priority ?? 9) - (b.priority ?? 9) : 0) || a.position - b.position;

  const drawBoard = () => {
    const shown = cards.filter(matches);
    body.innerHTML = `${outreach ? stats(shown) : ''}<div class="kanban">${stages
      .map((s) => {
        const list = shown.filter((c) => c.stage === s.key).sort(byOrder);
        const total = list.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
        return `<section class="kanban-col kind-${esc(s.kind || 'open')}${list.length ? '' : ' is-empty'}" data-stage="${esc(s.key)}" aria-label="${esc(s.label)}">
          <header><h2>${esc(s.label)}</h2><span class="muted small">${list.length}${total ? ` · ${fmtMoney(total)}` : ''}</span></header>
          <div class="kanban-cards" data-drop="${esc(s.key)}">${list.map(cardHtml).join('') || '<p class="kanban-empty muted small">Nothing here.</p>'}</div>
          ${canEdit() ? `<form class="kanban-add" data-add="${esc(s.key)}"><input type="text" placeholder="+ Add a sponsor" aria-label="Add a sponsor to ${esc(s.label)}" maxlength="120"></form>` : ''}
        </section>`;
      })
      .join('')}</div>
      <p class="hint hide-touch">Drag cards between columns. Click a card for its details, notes and history.</p>`;
  };

  // ---- By sponsor: one row per sponsor, every car and season they were on ----
  const sponsorRows = () =>
    [...groups.values()]
      .filter(groupMatches)
      .map((list) => ({ list, latest: list[0], gave: list.reduce((sum, c) => sum + gaveOf(stages, c), 0) }))
      .sort((a, b) => b.gave - a.gave || b.list.length - a.list.length || a.latest.name.localeCompare(b.latest.name));
  const drawSponsors = () => {
    const rows = sponsorRows();
    body.innerHTML = rows.length
      ? `<p class="muted small">${rows.length} sponsor${rows.length === 1 ? '' : 's'} · ${rows.filter((r) => r.list.length > 1).length} on more than one car or season.
          Biggest givers first. Cards with different names for the same sponsor can be linked on the card (This sponsor over the years).</p>
        <div class="table-wrap"><table class="table stack-mobile sponsor-list">
          <thead><tr><th>Sponsor</th><th>Cars &amp; seasons</th><th class="num">Given in all</th><th>Latest</th><th>Tags</th></tr></thead>
          <tbody>${rows
            .map(({ list, latest, gave }) => `<tr class="clickable" data-href="#/sponsors/${esc(latest.id)}">
              <td class="cell-primary" data-label=""><a class="title-link" href="#/sponsors/${esc(latest.id)}">${esc(latest.name)}</a>${
                list.some((c) => c.playbook) ? ' <span class="field-tag" title="Has tips for next time">Tips</span>' : ''}</td>
              <td data-label="Cars &amp; seasons">${list.map((c) => `<a class="chip" href="#/sponsors/${esc(c.id)}">${esc(whenOf(c))}</a>`).join(' ')}</td>
              <td class="num" data-label="Given in all">${gave ? fmtMoney(gave) : '—'}</td>
              <td data-label="Latest">${esc(stageLabel(latest.stage))}</td>
              <td data-label="Tags">${[...new Set(list.flatMap((c) => c.tags || []))].slice(0, 6).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</td>
            </tr>`)
            .join('')}</tbody></table></div>`
      : '<div class="empty">No sponsors match.</div>';
  };

  // ---- Ask again: past sponsors who aren't on this season's board yet ----
  const picked = new Set();
  const askCar = () => el.querySelector('#ask-car')?.value.trim() ?? (carsOf(cards.filter((c) => c.season === config.season))[0] || cars[0] || '');
  const drawAgain = () => {
    const car = askCar();
    const rows = sponsorRows().filter(({ list }) => !list.some((c) => c.season === config.season || (car && c.car === car && !c.season)));
    for (const k of [...picked]) if (!rows.some((r) => sponsorKey(r.latest) === k)) picked.delete(k);
    const lost = (c) => stages.find((s) => s.key === c.stage)?.kind === 'lost';
    body.innerHTML = `<section class="card ask-bar">
        <p>Sponsors from earlier cars and seasons who aren't on the <strong>${esc(config.season)}</strong> board yet, biggest givers first.
          Tick the ones to ask again: each gets a card in <strong>${esc(stages[0].label)}</strong> with their latest contacts, notes and tips (no lead or amount yet).</p>
        ${canEdit() ? `<div class="ask-go">
          <label for="ask-car">For the car</label>
          <input id="ask-car" maxlength="40" list="ask-cars" value="${esc(car)}" placeholder="e.g. Blaze">
          <datalist id="ask-cars">${cars.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <button type="button" class="btn btn-primary" id="ask-go" ${picked.size ? '' : 'disabled'}>Add ${picked.size} to ${esc(config.season)}</button>
        </div>` : ''}
      </section>
      ${rows.length ? `<div class="table-wrap"><table class="table stack-mobile sponsor-list ask-list">
        <thead><tr>${canEdit() ? `<th><input type="checkbox" id="ask-all" aria-label="Tick or untick all" ${picked.size === rows.length ? 'checked' : ''}></th>` : ''}<th>Sponsor</th><th>Before</th><th class="num">Gave</th><th>Last time</th><th>Contact</th></tr></thead>
        <tbody>${rows
          .map(({ list, latest, gave }) => `<tr>
            ${canEdit() ? `<td class="item-tick"><input type="checkbox" data-ask="${esc(sponsorKey(latest))}" ${picked.has(sponsorKey(latest)) ? 'checked' : ''} aria-label="Ask ${esc(latest.name)} again"></td>` : ''}
            <td class="cell-primary" data-label=""><a class="title-link" href="#/sponsors/${esc(latest.id)}">${esc(latest.name)}</a>${
              list.some((c) => c.playbook) ? ' <span class="field-tag" title="Has tips for next time (see This sponsor over the years on the card)">Tips</span>' : ''}
              ${latest.kind || latest.tags?.length ? `<div class="muted small">${esc([latest.kind?.replace(/ \(.*/, ''), ...(latest.tags || []).slice(0, 3)].filter(Boolean).join(' · '))}</div>` : ''}</td>
            <td data-label="Before">${list.map((c) => esc(whenOf(c))).join(', ')}</td>
            <td class="num" data-label="Gave">${gave ? fmtMoney(gave) : '—'}</td>
            <td data-label="Last time">${lost(latest) ? `<span class="late-tag">${esc(stageLabel(latest.stage))}</span>` : esc(stageLabel(latest.stage))}</td>
            <td data-label="Contact">${latest.contact_email ? `<a href="mailto:${esc(latest.contact_email)}">${esc(latest.contact_name || latest.contact_email)}</a>` : esc(latest.contact_name || '—')}</td>
          </tr>`)
          .join('')}</tbody></table></div>` : `<div class="empty">Every past sponsor${view.q ? ' that matches' : ''} is already on the ${esc(config.season)} board.</div>`}`;
  };
  const updateAskButton = () => {
    const btn = el.querySelector('#ask-go');
    if (!btn) return;
    btn.disabled = !picked.size;
    btn.textContent = `Add ${picked.size} to ${config.season}`;
  };

  const drawList = () => {
    const shown = cards.filter(matches).sort((a, b) => (b.season || '').localeCompare(a.season || '') || a.name.localeCompare(b.name));
    const total = shown.reduce((s, c) => s + (['received', 'done'].includes(stages.find((x) => x.key === c.stage)?.kind) ? Number(c.amount) || 0 : 0), 0);
    body.innerHTML = shown.length
      ? `<p class="muted small">${shown.length} sponsor card${shown.length === 1 ? '' : 's'}${total ? ` · ${fmtMoney(total)} received` : ''}</p>
        <div class="table-wrap"><table class="table stack-mobile sponsor-list">
          <thead><tr><th>Sponsor</th><th>Season</th>${cars.length ? '<th>Car</th>' : ''}<th>Type</th><th>Stage</th><th class="num">Amount</th><th>Lead</th><th>Tags</th></tr></thead>
          <tbody>${shown
            .map(
              (c) => `<tr class="clickable" data-href="#/sponsors/${esc(c.id)}">
                <td class="cell-primary" data-label=""><a class="title-link" href="#/sponsors/${esc(c.id)}">${esc(c.name)}</a>${
                  c.playbook ? ' <span class="field-tag" title="Has tips for next time">Tips</span>' : ''}${returning(c)}</td>
                <td data-label="Season">${esc(c.season || '—')}</td>
                ${cars.length ? `<td data-label="Car">${esc(c.car || '—')}</td>` : ''}
                <td data-label="Type">${esc(c.kind || '—')}</td>
                <td data-label="Stage">${esc(stageLabel(c.stage))}</td>
                <td class="num" data-label="Amount">${c.amount !== null && c.amount !== undefined ? fmtMoney(c.amount) : '—'}</td>
                <td data-label="Lead">${esc(nameOf(c.owner_id) || '—')}</td>
                <td data-label="Tags">${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : `<div class="empty">No sponsors match. Try another season${cars.length ? ', car' : ''} or search.${
          view.mode === 'board' && cars.length ? ' Sponsors of earlier cars without a season are under <strong>All sponsors</strong> → Every season.' : ''}</div>`;
  };

  const draw = () => ({ board: drawBoard, sponsors: drawSponsors, again: drawAgain }[view.mode] || drawList)();

  const create = async (stage, name) => {
    try {
      const season = view.season !== 'all' ? view.season : config.season;
      // The car: the one being looked at, or the one this season's cards are for.
      const car = view.car || carsOf(cards.filter((c) => c.season === season))[0] || '';
      const id = await api.saveSponsorCard(null, { name, stage, season, ...(car ? { car } : {}) });
      return id;
    } catch (err) {
      errors.innerHTML = errorBox(err);
      return null;
    }
  };

  // Moving: drag and drop (desktop) or the small menu on each card (phones).
  const move = async (id, stage, beforeId) => {
    const card = cards.find((c) => c.id === id);
    const col = cards.filter((c) => c.stage === stage && c.id !== id).sort((a, b) => a.position - b.position);
    const i = beforeId ? col.findIndex((c) => c.id === beforeId) : col.length;
    const prev = col[i - 1]?.position ?? (col[0]?.position ?? 1) - 1;
    const next = col[i]?.position ?? prev + 2;
    const position = (prev + next) / 2;
    const before = { stage: card.stage, position: card.position };
    Object.assign(card, { stage, position });
    draw();
    try {
      await api.moveSponsorCard(id, stage, position);
      errors.innerHTML = '';
      const kind = stages.find((s) => s.key === stage)?.kind;
      if (before.stage !== stage && kind === 'received' && card.amount) {
        const label = stages.find((s) => s.key === stage).label;
        setFlash(sponsorSettings(config).income.sheet
          ? `${card.name} moved to ${label}. Its ${fmtMoney(card.amount)} counts on the Finances Funding tab and was added to your income sheet (once per card).`
          : `${card.name} moved to ${label}. Its ${fmtMoney(card.amount)} now counts on the Finances Funding tab.`);
        rerender();
      }
    } catch (err) {
      Object.assign(card, before);
      draw();
      errors.innerHTML = errorBox(err);
    }
  };

  let dragging = null;
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.kcard');
    if (!card) return;
    dragging = card.dataset.card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    card.classList.add('is-dragging');
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.querySelectorAll('.is-dragging, .is-over').forEach((n) => n.classList.remove('is-dragging', 'is-over'));
  });
  el.addEventListener('dragover', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    if (!zone || !dragging) return;
    e.preventDefault();
    el.querySelectorAll('.is-over').forEach((n) => n !== zone && n.classList.remove('is-over'));
    zone.classList.add('is-over');
  });
  el.addEventListener('drop', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    if (!zone || !dragging) return;
    e.preventDefault();
    const after = [...zone.querySelectorAll('.kcard:not(.is-dragging)')].find((n) => e.clientY < n.getBoundingClientRect().top + n.offsetHeight / 2);
    move(dragging, zone.dataset.drop, after?.dataset.card);
  });

  el.addEventListener('change', (e) => {
    if (e.target.dataset.move) return move(e.target.dataset.move, e.target.value);
    if (e.target.id === 'sp-season') {
      view.season = e.target.value;
      return draw();
    }
    if (e.target.id === 'sp-car') {
      view.car = e.target.value;
      return draw();
    }
    if (e.target.id === 'sp-who') {
      view.who = e.target.value;
      return draw();
    }
    if (e.target.id === 'sp-sort') {
      view.sort = e.target.value;
      return draw();
    }
    if (e.target.dataset.ask) {
      if (e.target.checked) picked.add(e.target.dataset.ask);
      else picked.delete(e.target.dataset.ask);
      return updateAskButton();
    }
    if (e.target.id === 'ask-all') {
      el.querySelectorAll('[data-ask]').forEach((box) => {
        box.checked = e.target.checked;
        if (box.checked) picked.add(box.dataset.ask);
        else picked.delete(box.dataset.ask);
      });
      return updateAskButton();
    }
    if (e.target.id === 'ask-car') return draw();
  });
  el.querySelector('#sp-q').addEventListener('input', (e) => {
    view.q = e.target.value;
    draw();
  });
  el.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-add]');
    if (!form) return;
    e.preventDefault();
    const name = form.querySelector('input').value.trim();
    if (!name) return;
    const id = await create(form.dataset.add, name);
    if (id) {
      cards = await api.listSponsorCards();
      draw();
      el.querySelector(`[data-add="${CSS.escape(form.dataset.add)}"] input`)?.focus();
    }
  });
  el.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) location.hash = row.dataset.href;
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.mode) {
      view.mode = btn.dataset.mode;
      if (view.mode === 'board' && view.season === 'all') view.season = config.season;
      return rerender();
    }
    if (btn.id === 'new-card') {
      const name = prompt('Sponsor or donor name:')?.trim();
      if (!name) return;
      const id = await create(stages[0].key, name);
      if (id) location.hash = `#/sponsors/${id}`;
    }
    if (btn.dataset.claim) {
      btn.disabled = true;
      try {
        await api.claimSponsorCard(btn.dataset.claim, true);
        setFlash(`You're on ${cards.find((c) => c.id === btn.dataset.claim)?.name || 'it'}. Log it on the card once you've emailed them.`);
        return rerender();
      } catch (err) {
        errors.innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
    if (btn.id === 'ask-go') {
      const car = askCar();
      const ids = [...picked].map((k) => groups.get(k)?.[0]?.id).filter(Boolean);
      if (!confirm(`Add ${ids.length} past sponsor${ids.length === 1 ? '' : 's'} to the ${config.season} board${car ? ` for ${car}` : ''}, in "${stages[0].label}"?`)) return;
      btn.disabled = true;
      try {
        const n = await api.askSponsorsAgain(ids, config.season, car);
        setFlash(`Added ${n} past sponsor${n === 1 ? '' : 's'} to the ${config.season} board${car ? ` for ${car}` : ''}. Claim one with "I'll reach out".`);
        Object.assign(view, { mode: 'board', season: config.season, q: '', who: '' });
        return rerender();
      } catch (err) {
        errors.innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
    if (btn.id === 'sp-tags') {
      btn.hidden = true;
      openTags(el.querySelector('#settings-box'), { cards, rerender, onDone: () => (btn.hidden = false) });
    }
    if (btn.id === 'sp-import') {
      btn.hidden = true;
      openImport(el.querySelector('#settings-box'), { config, cards, cars, rerender, onDone: () => (btn.hidden = false) });
    }
    if (btn.id === 'board-settings') {
      btn.hidden = true;
      openSettings(el.querySelector('#settings-box'), { config, reloadConfig, rerender, onDone: () => (btn.hidden = false) });
    }
  });

  draw();
}

// ---- Tags: rename or merge across every card (027) ---------------------------------------

function openTags(box, { cards, rerender, onDone }) {
  let all = cards;
  const draw = (message = '') => {
    const counts = {};
    all.forEach((c) => (c.tags || []).forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    const sets = tagLookalikes(counts);
    const tags = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    box.innerHTML = `<section class="card">
      <h2>Tags</h2>
      <p class="muted small">Rename a tag on every card. Renaming it to a tag that's already used merges the two; × removes it from every card.</p>
      ${message ? `<div class="alert alert-success" role="status">${esc(message)}</div>` : ''}
      ${sets.length ? `<h3 class="sub-heading">Spelled differently, probably the same</h3>
        <ul class="tag-merge">${sets
          .map((set) => `<li>${set.map((t) => `<span class="tag">${esc(t)}</span> <span class="muted small">${counts[t]}</span>`).join(' ')}
            <button type="button" class="btn btn-sm" data-merge="${esc(JSON.stringify(set))}">Merge into "${esc(set[0])}"</button></li>`)
          .join('')}</ul>` : ''}
      ${tags.length ? `<div class="table-wrap tag-table"><table class="table">
        <thead><tr><th>Tag</th><th class="num">Cards</th><th>Rename to</th><th></th></tr></thead>
        <tbody>${tags
          .map((t) => `<tr data-tag="${esc(t)}"><td><span class="tag">${esc(t)}</span></td><td class="num">${counts[t]}</td>
            <td><input type="text" data-new-name value="${esc(t)}" maxlength="40" aria-label="New name for ${esc(t)}"></td>
            <td class="nowrap"><button type="button" class="btn btn-sm" data-rename>Rename</button>
              <button type="button" class="icon-btn" data-remove aria-label="Remove ${esc(t)} from every card" title="Remove from every card">&times;</button></td></tr>`)
          .join('')}</tbody></table></div>` : '<p class="muted">No tags yet.</p>'}
      <div id="tag-errors"></div>
      <div class="form-actions"><button type="button" class="btn btn-primary" id="tags-done">Done</button></div>
    </section>`;
  };
  const run = async (pairs, message) => {
    try {
      let n = 0;
      for (const [from, to] of pairs) n += await api.renameSponsorTag(from, to);
      all = await api.listSponsorCards();
      draw(message.replace('{n}', `${n} card${n === 1 ? '' : 's'}`));
    } catch (err) {
      box.querySelector('#tag-errors').innerHTML = errorBox(err);
    }
  };
  box.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'tags-done') {
      box.innerHTML = '';
      onDone();
      return rerender();
    }
    if (btn.dataset.merge) {
      const [into, ...rest] = JSON.parse(btn.dataset.merge);
      return run(rest.map((t) => [t, into]), `Merged into "${into}" on {n}.`);
    }
    const row = btn.closest('tr[data-tag]');
    if (!row) return;
    const from = row.dataset.tag;
    if (btn.hasAttribute('data-remove')) {
      if (!confirm(`Remove the tag "${from}" from every card?`)) return;
      return run([[from, '']], `Removed "${from}" from {n}.`);
    }
    const to = row.querySelector('[data-new-name]').value.trim();
    if (!to) return alert('Write the new name, or use × to remove the tag.');
    if (to !== from) run([[from, to]], `Renamed "${from}" to "${to}" on {n}.`);
  };
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-new-name]')) e.target.closest('tr').querySelector('[data-rename]').click();
  };
  draw();
}

// ---- Importing an old sponsor spreadsheet (026) -------------------------------------------

function openImport(box, { config, cards, cars, rerender, onDone }) {
  const { stages, kinds } = sponsorSettings(config);
  const finished = stages.find((s) => s.kind === 'done') || stages.find((s) => s.kind === 'received') || stages[0];
  const seasons = [...new Set(cards.map((c) => c.season).filter(Boolean))].sort().reverse();
  const stageLabel = (k) => stages.find((s) => s.key === k)?.label || k;
  const opts = { car: '', season: '', stage: stages[0].key };
  let file = null;
  let rows = [];
  const close = () => {
    box.innerHTML = '';
    onDone();
  };
  const cardOf = (r) => toSponsorCard(r, { ...opts, stages, kinds });
  const onBoard = (c) => cards.some((x) => x.name.toLowerCase() === c.name.toLowerCase() && x.season === c.season && (x.car || '') === c.car);

  const drawPick = (err) => {
    box.innerHTML = `<section class="card">
      <h2>Import sponsors from a spreadsheet</h2>
      <p class="muted small">An Excel (.xlsx) or CSV list of sponsors, e.g. an earlier car's sponsor list or this year's outreach tracker.
        Every sheet with a <strong>Sponsor name</strong> or <strong>Company</strong> column is read. Columns like amount, level, what they gave,
        contacts, team member, system, status and notes are recognised; anything else is kept in the card's "About this sponsor".
        You'll see the list before anything is added.</p>
      <div class="field"><label for="imp-file">Spreadsheet</label><input type="file" id="imp-file" accept=".xlsx,.csv,.tsv,.txt"></div>
      <div id="imp-errors">${err ? errorBox(err) : ''}</div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" id="imp-cancel">Cancel</button></div>
    </section>`;
  };

  const drawRows = () => {
    const sheets = new Set(rows.map((r) => r.sheet)).size > 1;
    const list = rows.map((r) => ({ r, c: cardOf(r) }));
    box.querySelector('#imp-rows').innerHTML = list
      .map(({ r, c }, i) => {
        const note = onBoard(c) ? 'Already on the board; will be skipped' : r.junk || '';
        return `<tr class="${r.on ? '' : 'is-muted'}">
          <td class="item-tick"><input type="checkbox" data-imp-row="${i}" ${r.on ? 'checked' : ''} aria-label="Import ${esc(c.name)}"></td>
          <td class="cell-primary" data-label="">${esc(c.name)}${note ? ` <span class="muted small">· ${esc(note)}</span>` : ''}</td>
          ${sheets ? `<td data-label="Sheet">${esc(r.sheet)}</td>` : ''}
          <td data-label="Type">${esc(c.kind || '—')}</td>
          <td class="num" data-label="Amount">${c.amount ? fmtMoney(c.amount) : '—'}</td>
          <td data-label="Stage">${esc(stageLabel(c.stage))}</td>
          <td data-label="Tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</td>
        </tr>`;
      })
      .join('');
    const n = rows.filter((r) => r.on).length;
    const btn = box.querySelector('#imp-go');
    btn.textContent = `Import ${n} sponsor${n === 1 ? '' : 's'}`;
    btn.disabled = !n;
  };

  const drawPreview = () => {
    const hasStatus = rows.some((r) => r.status || r.outcome);
    const sheets = new Set(rows.map((r) => r.sheet)).size > 1;
    box.innerHTML = `<section class="card">
      <h2>Import ${esc(file.name)}</h2>
      <div class="form-grid">
        <div class="field"><label for="imp-car">Car</label>
          <input id="imp-car" maxlength="40" list="imp-cars" value="${esc(opts.car)}" placeholder="e.g. Sunrider, Flare, Blaze">
          <datalist id="imp-cars">${cars.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <div class="hint">Which car these sponsors were for. Find them later with the car filter in All sponsors.</div></div>
        <div class="field"><label for="imp-season">Season <span class="muted small">(optional)</span></label>
          <input id="imp-season" maxlength="9" list="imp-seasons" value="${esc(opts.season)}" placeholder="e.g. 2019-2020">
          <datalist id="imp-seasons">${[config.season, ...seasons].filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
          <div class="hint">Cards with this season show on that season's board. Leave it empty if you don't know it.</div></div>
        <div class="field"><label for="imp-stage">${hasStatus ? 'Stage for sponsors with no status' : 'Stage'}</label>
          <select id="imp-stage">${stages.map((s) => `<option value="${esc(s.key)}" ${s.key === opts.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
          <div class="hint">${hasStatus ? 'The outreach status and outcome columns set the rest (Email sent → Contacted, Declined → Not this year…).' : `For a past car's sponsors, ${esc(finished.label)}.`}
            Imported cards never add money to Finances.</div></div>
      </div>
      <p class="muted small">${rows.length} row${rows.length === 1 ? '' : 's'}. Untick any you don't want. Nobody is set to watch the new cards; a team member's name becomes the card's lead when someone on the site has exactly that name.</p>
      <div class="table-wrap import-preview sponsor-import"><table class="table stack-mobile">
        <thead><tr><th><input type="checkbox" id="imp-all" aria-label="Tick or untick all" ${rows.every((r) => r.on) ? 'checked' : ''}></th><th>Sponsor</th>${sheets ? '<th>Sheet</th>' : ''}<th>Type</th><th class="num">Amount</th><th>Stage</th><th>Tags</th></tr></thead>
        <tbody id="imp-rows"></tbody></table></div>
      <div id="imp-errors"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="imp-cancel">Cancel</button>
        <button type="button" class="btn" id="imp-other">Choose another file</button>
        <button type="button" class="btn btn-primary" id="imp-go">Import</button>
      </div>
    </section>`;
    drawRows();
  };

  box.oninput = (e) => {
    if (e.target.id === 'imp-car') opts.car = e.target.value.trim();
    else if (e.target.id === 'imp-season') opts.season = e.target.value.trim();
    else return;
    drawRows();
  };
  box.onchange = async (e) => {
    if (e.target.id === 'imp-file' && e.target.files[0]) {
      file = e.target.files[0];
      try {
        const sheets = await readItemFile(file);
        rows = sheets.flatMap((s) => readSponsorRows(s.grid, { sheet: sheets.length > 1 ? s.name : '' }));
        if (!rows.length) throw new Error(`Couldn't find a list of sponsors in ${file.name}: no sheet has a "Sponsor name" or "Company" column.`);
        rows.forEach((r) => (r.on = !r.junk));
        const hasStatus = rows.some((r) => r.status || r.outcome);
        Object.assign(opts, { car: guessCar(file.name), season: hasStatus ? config.season || '' : '', stage: hasStatus ? stages[0].key : finished.key });
        drawPreview();
      } catch (err) {
        drawPick(err);
      }
    } else if (e.target.id === 'imp-stage') {
      opts.stage = e.target.value;
      drawRows();
    } else if (e.target.dataset.impRow) {
      rows[Number(e.target.dataset.impRow)].on = e.target.checked;
      drawRows();
    } else if (e.target.id === 'imp-all') {
      rows.forEach((r) => (r.on = e.target.checked));
      drawRows();
    }
  };
  box.onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'imp-cancel') return close();
    if (btn.id === 'imp-other') return drawPick();
    if (btn.id !== 'imp-go') return;
    if (opts.season && !/^\d{4}-\d{4}$/.test(opts.season)) {
      box.querySelector('#imp-errors').innerHTML = errorBox(new Error('Write the season like 2019-2020, or leave it empty.'));
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const { added, skipped } = await api.importSponsorCards(rows.filter((r) => r.on).map(cardOf), file.name);
      setFlash(`Added ${added} sponsor${added === 1 ? '' : 's'} from ${file.name}${opts.car ? ` for ${opts.car}` : ''}.${
        skipped.length ? ` Skipped ${skipped.length} already on the board: ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? '…' : ''}.` : ''}`);
      Object.assign(view, { mode: 'list', season: 'all', car: opts.car, q: '', who: '' });
      rerender();
    } catch (err) {
      box.querySelector('#imp-errors').innerHTML = errorBox(err);
      drawRows();
    }
  };
  drawPick();
}

// ---- Board settings: stages, kinds, where received money goes ----------------------------

async function openSettings(box, { config, reloadConfig, rerender, onDone }) {
  const current = sponsorSettings(config);
  const state = { stages: structuredClone(current.stages), kinds: [...current.kinds], income: structuredClone(current.income) };
  const sheets = auth.can('finances.view') || auth.can('finances.edit') ? await api.listFinanceSheets().catch(() => []) : [];
  const keyFor = (label) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'stage';
    let key = base;
    for (let n = 2; state.stages.some((s) => s.key === key); n++) key = `${base}_${n}`;
    return key;
  };
  /** Which columns of the income sheet get the date, sponsor, type and amount (matched by name and type). */
  const mapColumns = (sheet) => {
    const cols = sheet?.columns || [];
    const find = (re, types) => cols.find((c) => re.test(c.label) && (!types || types.includes(c.type)))?.key;
    return Object.fromEntries(
      Object.entries({
        date: find(/date/i, ['date', 'text']),
        from: find(/from|sponsor|donor|name|who/i, ['text', 'select']),
        type: find(/type|kind|category/i, ['select', 'text']),
        amount: find(/amount|total|\$|money/i, ['money', 'number']) || cols.find((c) => c.type === 'money')?.key,
        received: find(/received|paid/i, ['checkbox']),
        notes: find(/note|memo|description/i, ['text']),
      }).filter(([, v]) => v)
    );
  };

  const draw = () => {
    const sheet = sheets.find((s) => s.id === state.income.sheet);
    box.innerHTML = `<section class="card">
      <h2>Board settings</h2>
      <h3 class="sub-heading">Stages</h3>
      <ol class="stage-list">${state.stages
        .map(
          (s, i) => `<li data-i="${i}">
            <span class="col-move">
              <button type="button" class="icon-btn" data-stage-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(s.label)} left">←</button>
              <button type="button" class="icon-btn" data-stage-move="1" ${i === state.stages.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(s.label)} right">→</button>
            </span>
            <input type="text" data-stage-label value="${esc(s.label)}" maxlength="40" aria-label="Stage name">
            <select data-stage-kind aria-label="What this stage means">${STAGE_KINDS.map(([k, l]) => `<option value="${k}" ${k === (s.kind || 'open') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
            <button type="button" class="icon-btn" data-stage-del aria-label="Delete stage ${esc(s.label)}" title="Delete stage">&times;</button>
          </li>`
        )
        .join('')}</ol>
      <button type="button" class="btn btn-sm" id="stage-add">+ Add stage</button>
      <p class="hint">Cards in a deleted stage move to the first stage. The first stage is where new sponsors start.</p>

      <h3 class="sub-heading">Types</h3>
      <textarea id="kinds" rows="4" placeholder="One per line">${esc(state.kinds.join('\n'))}</textarea>

      <h3 class="sub-heading">When money is received</h3>
      <p class="muted small">Cards in a "money received" stage count on the <a href="#/finances">Finances</a> Funding tab on their own.</p>
      ${sheets.length
        ? `<details class="about" ${state.income.sheet ? 'open' : ''}><summary>Also copy it into one of your own sheets</summary>
            <div class="field"><label for="income-sheet">Add a row to this Finances sheet</label>
            <select id="income-sheet"><option value="">Don't add anything</option>${sheets.map((s) => `<option value="${esc(s.id)}" ${s.id === state.income.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
            ${sheet ? `<div class="hint">Fills in: ${Object.entries(state.income.columns || {}).map(([k, key]) => `${esc({ date: 'date', from: 'sponsor name', type: 'type', amount: 'amount', received: 'received ✓', notes: 'a note' }[k])} → ${esc(sheet.columns.find((c) => c.key === key)?.label || '?')}`).join(', ') || 'nothing (no matching columns)'}.
              Matched by column names; rename columns in Finances to change it.</div>` : ''}</div></details>`
        : ''}
      <div id="set-errors"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="set-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="set-save">Save board settings</button>
      </div>
    </section>`;
  };

  box.oninput = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && e.target.matches('[data-stage-label]')) state.stages[Number(li.dataset.i)].label = e.target.value;
    if (e.target.id === 'kinds') state.kinds = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
  };
  box.onchange = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && e.target.matches('[data-stage-kind]')) state.stages[Number(li.dataset.i)].kind = e.target.value;
    if (e.target.id === 'income-sheet') {
      const sheet = sheets.find((s) => s.id === e.target.value);
      state.income = sheet ? { sheet: sheet.id, columns: mapColumns(sheet) } : {};
      draw();
    }
  };
  box.onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('li[data-i]');
    const i = li ? Number(li.dataset.i) : -1;
    if (btn.dataset.stageMove) {
      const to = i + Number(btn.dataset.stageMove);
      [state.stages[i], state.stages[to]] = [state.stages[to], state.stages[i]];
      draw();
    } else if (btn.hasAttribute('data-stage-del')) {
      if (state.stages.length === 1) return alert('The board needs at least one stage.');
      if (!confirm(`Delete the stage "${state.stages[i].label}"? Its cards move to the first stage.`)) return;
      state.stages.splice(i, 1);
      draw();
    } else if (btn.id === 'stage-add') {
      state.stages.push({ key: keyFor('New stage'), label: 'New stage', kind: 'open' });
      draw();
      [...box.querySelectorAll('[data-stage-label]')].pop()?.select();
    } else if (btn.id === 'set-cancel') {
      box.innerHTML = '';
      onDone();
    } else if (btn.id === 'set-save') {
      if (state.stages.some((s) => !s.label.trim())) {
        box.querySelector('#set-errors').innerHTML = errorBox(new Error('Every stage needs a name.'));
        return;
      }
      btn.disabled = true;
      try {
        // Keep whatever income sheet was set if this person can't see Finances.
        const income = sheets.length ? state.income : current.income;
        await api.saveSponsorSettings({ ...(config.sponsors || {}), stages: state.stages.map((s) => ({ ...s, label: s.label.trim() })), kinds: state.kinds, income });
        await reloadConfig();
        setFlash('Board settings saved.');
        rerender();
      } catch (err) {
        box.querySelector('#set-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
  };
  draw();
}

// ---- One card ------------------------------------------------------------------------------

export async function renderSponsorCard(el, { config, params, rerender }) {
  let card;
  try {
    card = await api.getSponsorCard(params.id);
  } catch (err) {
    el.innerHTML = `<a class="back-link" href="#/sponsors">← Sponsors board</a><div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const { stages, kinds } = sponsorSettings(config);
  const [{ all: people, viewers }, cards] = await Promise.all([boardPeople(), api.listSponsorCards()]);
  const nameOf = (id) => people.find((p) => p.id === id)?.full_name || 'Someone';
  const stageLabel = (k) => stages.find((s) => s.key === k)?.label || k;
  // Renewing makes sense once this season's ask is over (received, thanked, or not this year).
  const finished = ['received', 'done', 'lost'].includes(stages.find((s) => s.key === card.stage)?.kind);
  const editable = canEdit();
  const me = auth.user.id;
  const watching = card.watchers.includes(me);
  const renewedFrom = cards.find((c) => c.id === card.renewed_from);
  const renewals = cards.filter((c) => c.renewed_from === card.id);
  // The same sponsor on other cars and seasons (027).
  const outreach = hasOutreach(config);
  const groups = outreach ? groupSponsors(cards) : new Map();
  const myKey = sponsorKey(card);
  const group = groups.get(myKey) || [card];
  const others = group.filter((c) => c.id !== card.id);
  const isLead = card.owner_id === me;
  const canView = editable || auth.can('sponsors.view');
  const categories = [...new Set(cards.map((c) => c.category).filter(Boolean))].sort();
  // Similar sponsors (other cards with a shared tag or the same type), most in common first.
  const similar = cards
    .filter((c) => c.id !== card.id && c.id !== card.renewed_from && c.renewed_from !== card.id && !group.includes(c))
    .map((c) => ({ c, score: (c.tags || []).filter((t) => (card.tags || []).includes(t)).length * 2 + (c.kind && c.kind === card.kind ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  // An earlier car's card with no season: bring it to this season's board.
  const nextSeason = (() => {
    if (!card.season && card.car) return config.season || '';
    const y = Number(String(card.season || config.season).split('-')[0]);
    return y ? `${y + 1}-${y + 2}` : '';
  })();

  const field = (label, html, wide = false) => `<div class="field ${wide ? 'span-2' : ''}"><label>${label}</label>${html}</div>`;
  const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
  const read = (v) => `<div class="read-value">${v || '<span class="muted">—</span>'}</div>`;

  el.innerHTML = `
    ${takeFlash()}
    <a class="back-link" href="#/sponsors">← Sponsors board</a>
    <div class="page-header">
      <div>
        <p class="eyebrow">${[card.season, card.car, card.kind].filter(Boolean).map(esc).join(' · ')}</p>
        <h1>${esc(card.name)}</h1>
        <p class="subtitle"><span class="badge tone-blue">${esc(stageLabel(card.stage))}</span>
          ${card.amount !== null ? `<strong>${fmtMoney(card.amount)}</strong>` : ''}
          ${others.length ? `<span class="chip chip-return">↺ Returning sponsor</span>` : ''}
          ${renewedFrom ? `<span class="muted small">Renewed from <a href="#/sponsors/${esc(renewedFrom.id)}">${esc(whenOf(renewedFrom))}</a></span>` : ''}
          ${renewals.map((r) => `<span class="muted small">Renewed for <a href="#/sponsors/${esc(r.id)}">${esc(whenOf(r))}</a></span>`).join('')}
          ${outreach && card.owner_id && isOpen(stages, card) ? `<span class="muted small">${isLead ? 'You are' : `${esc(nameOf(card.owner_id))} is`} reaching out${card.contacted_on ? ` · contacted ${esc(fmtDate(card.contacted_on))}` : ''}</span>` : ''}</p>
      </div>
      <div class="card-actions">
        ${outreach && canView && isOpen(stages, card) && !card.owner_id ? '<button type="button" class="btn btn-primary" id="claim" title="Become the lead, so nobody else emails them too">I\'ll reach out</button>' : ''}
        ${outreach && (editable || isLead) ? '<button type="button" class="btn" id="log-contact">✉ Log contact…</button>' : ''}
        ${outreach && isLead && isOpen(stages, card) ? '<button type="button" class="btn btn-ghost" id="unclaim">Stop reaching out</button>' : ''}
        <button type="button" class="btn" id="watch">${watching ? '👁 Watching · Stop' : '👁 Watch'}</button>
        ${editable && nextSeason && finished && !renewals.some((r) => r.season === nextSeason) ? `<button type="button" class="btn" id="renew">Renew for ${esc(nextSeason)}</button>` : ''}
      </div>
    </div>
    <div id="card-errors"></div>
    ${outreach && (editable || isLead) ? `<form id="contact-form" class="card contact-box" hidden novalidate>
      <h2>Log contact</h2>
      <p class="muted small">After emailing or calling them. It goes in Notes &amp; history, sets the date contacted, and moves a card in ${esc(stages[0].label)} to ${esc(stageLabel(contactedStage(stages)))}.</p>
      <div class="form-grid">
        <div class="field"><label for="contact-date">When</label><input type="date" id="contact-date" value="${today()}" max="${today()}"></div>
        <div class="field span-2"><label for="contact-note">What happened <span class="muted small">(optional)</span></label>
          <textarea id="contact-note" rows="2" placeholder="e.g. Emailed Cindy the sponsorship packet; she'll ask her manager."></textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" id="contact-cancel">Cancel</button><button type="submit" class="btn btn-primary">Log it</button></div>
    </form>` : ''}
    <div class="detail-layout">
      <div>
        <form id="card-form" novalidate>
          <section class="card">
            <h2>Details</h2>
            <div class="form-grid">
              ${editable ? field('Name', input('name', card.name, 'maxlength="120" required'), true) : ''}
              ${field('Stage', editable ? `<select name="stage">${stages.map((s) => `<option value="${esc(s.key)}" ${s.key === card.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>` : read(esc(stageLabel(card.stage))))}
              ${field('Type', editable ? `<select name="kind"><option value=""></option>${[...new Set([...kinds, ...(card.kind ? [card.kind] : [])])].map((k) => `<option ${k === card.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>` : read(esc(card.kind)))}
              ${field('Amount ($)', editable ? input('amount', card.amount ?? '', 'inputmode="decimal" placeholder="e.g. 2500"') : read(card.amount !== null ? fmtMoney(card.amount) : ''))}
              ${field('Season', editable ? input('season', card.season, 'maxlength="9"') : read(esc(card.season)))}
              ${hasCars(config) ? field('Car', editable ? `${input('car', card.car, 'maxlength="40" list="car-names" placeholder="e.g. Blaze"')}<datalist id="car-names">${carsOf(cards).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` : read(esc(card.car))) : ''}
              ${field('Lead', editable ? `<select name="owner_id"><option value="">Nobody yet</option>${people.map((p) => `<option value="${esc(p.id)}" ${p.id === card.owner_id ? 'selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select>` : read(esc(card.owner_id ? nameOf(card.owner_id) : '')))}
              ${field('Follow up on', editable ? input('follow_up', card.follow_up ?? '', 'type="date"') : read(card.follow_up ? fmtDate(card.follow_up) : ''))}
              ${outreach ? `
              ${field('Priority', editable ? `<select name="priority"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === card.priority ? 'selected' : ''}>${n}${n === 1 ? ' (highest)' : ''}</option>`).join('')}</select>` : read(card.priority ? String(card.priority) : ''))}
              ${field('Date contacted', editable ? input('contacted_on', card.contacted_on ?? '', `type="date" max="${today()}"`) : read(card.contacted_on ? fmtDate(card.contacted_on) : ''))}
              ${field('Request category <span class="muted small">(what we\'re asking for, e.g. PCB sponsor, core material)</span>', editable ? `${input('category', card.category, 'maxlength="80" list="category-names"')}<datalist id="category-names">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` : read(esc(card.category)), true)}` : ''}
              ${field('Tags <span class="muted small">(comma-separated, e.g. aerospace, local, alumni)</span>', editable ? input('tags', (card.tags || []).join(', ')) : read((card.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')), true)}
            </div>
            <h3 class="sub-heading">Contact</h3>
            <div class="form-grid">
              ${field('Name', editable ? input('contact_name', card.contact_name) : read(esc(card.contact_name)))}
              ${field('Email', editable ? input('contact_email', card.contact_email, 'type="email"') : read(card.contact_email ? `<a href="mailto:${esc(card.contact_email)}">${esc(card.contact_email)}</a>` : ''))}
              ${field('Phone', editable ? input('contact_phone', card.contact_phone, 'type="tel"') : read(esc(card.contact_phone)))}
              ${field('Website', editable ? input('website', card.website, 'type="url" placeholder="https://"') : read(/^https?:\/\//.test(card.website) ? `<a href="${esc(card.website)}" target="_blank" rel="noopener">${esc(card.website)}</a>` : esc(card.website)))}
            </div>
          </section>
          <section class="card">
            <h2>About this sponsor</h2>
            ${editable
              ? `<textarea name="description" rows="7" placeholder="Who they are, what they gave or offered, what they asked for in return (logo on the car, social posts, a report…), deadlines and paperwork.">${esc(card.description)}</textarea>`
              : `<div class="rich">${card.description ? renderRichText(card.description) : '<p class="muted">Nothing written yet.</p>'}</div>`}
          </section>
          <section class="card playbook">
            <h2>Tips for next time</h2>
            <p class="muted small">For future teams: how we found them, who to ask, when to ask, what worked and what didn't.</p>
            ${editable
              ? `<textarea name="playbook" rows="6" placeholder="e.g. Ask in August, before their budget closes. Jane in Community Relations decides. They liked the team photo with their logo.">${esc(card.playbook)}</textarea>`
              : `<div class="rich">${card.playbook ? renderRichText(card.playbook) : '<p class="muted">Nothing written yet.</p>'}</div>`}
          </section>
          ${editable ? `<div class="form-actions sticky-actions">
            <span class="muted small" id="card-dirty" hidden>Unsaved changes</span>
            <button type="button" class="btn btn-danger reset-btn" id="delete-card">Delete card</button>
            <button type="submit" class="btn btn-primary" id="save-card" disabled>Save</button>
          </div>` : ''}
        </form>

        <section class="card">
          <h2>Notes &amp; history</h2>
          <form id="comment-form" class="comment-form" novalidate>
            <textarea id="comment" rows="2" placeholder="Add a note: a call, an email, what they said…" aria-label="Add a note"></textarea>
            <button type="submit" class="btn btn-sm">Add note</button>
          </form>
          <ol class="timeline sponsor-timeline">${card.activity
            .map((a) => {
              const what = {
                created: a.body ? `Added the card <span class="muted">· ${esc(a.body)}</span>` : 'Added the card',
                moved: `Moved from <strong>${esc(stageLabel(a.from_stage))}</strong> to <strong>${esc(stageLabel(a.to_stage))}</strong>`,
                edited: esc(a.body),
                comment: '',
                income: esc(a.body),
                renewed: esc(a.body),
                claimed: esc(a.body),
                contacted: esc(a.body.replace(/^Contacted/, 'contacted')),
              }[a.kind];
              return `<li class="tl-${esc(a.kind)}">
                <div><strong>${esc(a.actor_name || 'Someone')}</strong> ${what}</div>
                ${a.kind === 'comment' ? `<blockquote>${esc(a.body)}</blockquote>` : ''}
                <div class="muted small">${fmtDateTime(a.created_at)}</div>
              </li>`;
            })
            .join('')}</ol>
        </section>
      </div>

      <aside class="detail-side">
        ${outreach && (others.length || editable) ? `<section class="card">
          <h2>This sponsor over the years</h2>
          ${others.length
            ? `<ul class="history-list">${others
                .map((c) => `<li>
                  <a href="#/sponsors/${esc(c.id)}">${esc(whenOf(c))}</a>
                  <span class="muted small">${[stageLabel(c.stage), c.amount !== null && c.amount !== undefined ? fmtMoney(c.amount) : '', c.kind?.replace(/ \(.*/, '')].filter(Boolean).map(esc).join(' · ')}</span>
                  ${c.name.trim().toLowerCase() !== card.name.trim().toLowerCase() ? `<div class="muted small">as "${esc(c.name)}"</div>` : ''}
                  ${c.playbook ? `<div class="small history-tip">💡 ${esc(c.playbook.length > 160 ? `${c.playbook.slice(0, 160)}…` : c.playbook)}</div>` : ''}
                  ${editable ? `<button type="button" class="link-btn small" data-unlink="${esc(c.id)}">Not the same sponsor</button>` : ''}
                </li>`)
                .join('')}</ul>`
            : '<p class="muted small">Not on any other car or season yet.</p>'}
          ${editable ? `<select id="link-sponsor" aria-label="Same sponsor as another card"><option value="">+ Same sponsor as…</option>${[...groups]
            .filter(([k]) => k !== myKey)
            .map(([, list]) => list[0])
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(groups.get(sponsorKey(c)).map(whenOf).join(', '))})</option>`)
            .join('')}</select>
            <p class="hint">For the same sponsor under another name, e.g. "Digikey" and "Digikey Parts Distributor".</p>` : ''}
        </section>` : ''}
        <section class="card">
          <h2>Watchers</h2>
          <p class="muted small">Get an email / Teams message when this card moves or gets a note.</p>
          <ul class="watcher-list">${card.watchers
            .map((id) => `<li><span class="avatar">${esc(initials(nameOf(id)))}</span>${esc(nameOf(id))}${
              editable || id === me ? ` <button type="button" class="icon-btn" data-unwatch="${esc(id)}" aria-label="Remove ${esc(nameOf(id))}">&times;</button>` : ''}</li>`)
            .join('') || '<li class="muted small">Nobody yet.</li>'}</ul>
          ${editable ? `<select id="add-watcher" aria-label="Add a watcher"><option value="">+ Add a watcher…</option>${viewers
            .filter((p) => !card.watchers.includes(p.id))
            .map((p) => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)}</option>`)
            .join('')}</select>` : ''}
        </section>
        <div id="card-files"></div>
        ${similar.length ? `<section class="card">
          <h2>Similar sponsors</h2>
          <ul class="similar-list">${similar
            .map(({ c }) => `<li><a href="#/sponsors/${esc(c.id)}">${esc(c.name)}</a> <span class="muted small">${[c.season, c.car, stageLabel(c.stage)].filter(Boolean).map(esc).join(' · ')}${c.amount ? ` · ${fmtMoney(c.amount)}` : ''}</span></li>`)
            .join('')}</ul>
        </section>` : ''}
        <section class="card small muted">Added ${fmtDate(card.created_at)}${card.created_by ? ` by ${esc(nameOf(card.created_by))}` : ''}.</section>
      </aside>
    </div>`;

  renderAttachments(el.querySelector('#card-files'), {
    kind: 'sponsor', ownerId: card.id, canEdit: editable, framed: true,
    hint: 'Add a logo, agreement or link',
  }).catch(() => {});

  const errors = el.querySelector('#card-errors');
  const form = el.querySelector('#card-form');
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    el.querySelector('#save-card').disabled = false;
    el.querySelector('#card-dirty').hidden = false;
  };
  if (editable) {
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    guardLeaving(el, () => dirty);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editable) return;
    const data = Object.fromEntries(new FormData(form));
    const fields = {
      ...data,
      amount: String(data.amount || '').replace(/[$,\s]/g, ''),
      tags: String(data.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    };
    const btn = el.querySelector('#save-card');
    btn.disabled = true;
    try {
      await api.saveSponsorCard(card.id, fields);
      dirty = false;
      releaseGuard();
      setFlash('Saved.');
      rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
      errors.scrollIntoView({ behavior: 'smooth' });
      btn.disabled = false;
    }
  });

  el.querySelector('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = el.querySelector('#comment');
    if (!box.value.trim()) return;
    if (dirty && !confirm('You have unsaved changes to the details. Add the note anyway? (Your other changes will be lost.)')) return;
    try {
      await api.addSponsorComment(card.id, box.value);
      dirty = false;
      releaseGuard();
      rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });

  el.querySelector('#contact-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (dirty && !confirm('You have unsaved changes to the details. Log this anyway? (Your other changes will be lost.)')) return;
    try {
      await api.logSponsorContact(card.id, el.querySelector('#contact-date').value, el.querySelector('#contact-note').value);
      dirty = false;
      releaseGuard();
      setFlash('Logged. The date contacted is set.');
      rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });

  el.addEventListener('change', async (e) => {
    if (e.target.id === 'link-sponsor' && e.target.value) {
      const other = cards.find((c) => c.id === e.target.value);
      const key = sponsorKey(other);
      try {
        await api.setSponsorKey([...group, ...groups.get(key)].map((c) => c.id), key);
        if (!dirty) rerender();
      } catch (err) {
        errors.innerHTML = errorBox(err);
      }
      return;
    }
    if (e.target.id !== 'add-watcher' || !e.target.value) return;
    try {
      await api.setSponsorWatch(card.id, e.target.value, true);
      if (!dirty) rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.id === 'watch') {
        await api.setSponsorWatch(card.id, me, !watching);
        return rerender();
      }
      if (btn.id === 'claim' || btn.id === 'unclaim') {
        if (dirty && !confirm('You have unsaved changes to the details. Continue anyway? (Your other changes will be lost.)')) return;
        await api.claimSponsorCard(card.id, btn.id === 'claim');
        dirty = false;
        releaseGuard();
        setFlash(btn.id === 'claim' ? `You're the lead for ${card.name}. Use "Log contact" once you've emailed them.` : `You're no longer the lead for ${card.name}.`);
        return rerender();
      }
      if (btn.id === 'log-contact' || btn.id === 'contact-cancel') {
        const box = el.querySelector('#contact-form');
        box.hidden = btn.id === 'contact-cancel';
        if (!box.hidden) box.querySelector('#contact-note').focus();
        return;
      }
      if (btn.dataset.unlink) {
        await api.setSponsorKey([btn.dataset.unlink], `solo:${btn.dataset.unlink}`);
        if (!dirty) rerender();
        return;
      }
      if (btn.dataset.unwatch) {
        await api.setSponsorWatch(card.id, btn.dataset.unwatch, false);
        return rerender();
      }
      if (btn.id === 'renew') {
        if (!confirm(`Add ${card.name} to the ${nextSeason} board? Contacts, notes, tips and watchers are copied; it starts at "${stages[0].label}".`)) return;
        const id = await api.renewSponsorCard(card.id, nextSeason);
        setFlash(`Added ${card.name} to ${nextSeason}.`);
        location.hash = `#/sponsors/${id}`;
        return;
      }
      if (btn.id === 'delete-card') {
        if (!confirm(`Delete ${card.name} and its whole history? This can't be undone.\n\nTip: moving it to "${stages.find((s) => s.kind === 'lost')?.label || 'Not this year'}" keeps the history for future teams.`)) return;
        await api.deleteSponsorCard(card.id);
        dirty = false;
        releaseGuard();
        setFlash(`Deleted ${card.name}.`);
        location.hash = '#/sponsors';
      }
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });
}

/** For Home: open cards you lead or watch whose follow-up date has come. */
export async function sponsorFollowUps(config) {
  if (!auth.can('sponsors.view') && !auth.can('sponsors.edit')) return [];
  const { stages } = sponsorSettings(config);
  const me = auth.user.id;
  const cards = await api.listSponsorCards().catch(() => []);
  return cards
    .filter((c) => c.follow_up && c.follow_up <= today() && isOpen(stages, c) && (c.owner_id === me || c.watchers.includes(me)))
    .sort((a, b) => a.follow_up.localeCompare(b.follow_up));
}
