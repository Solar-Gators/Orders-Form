/**
 * Chief Engineer queue: every Submitted request (sortable), split into what's
 * waiting on you and what's waiting on someone else (Admin → Workflow rules).
 * Columns and the default sort come from Admin → Lists.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, fmtMoney, requestTable, bindRowLinks, bindSorting, takeFlash, introText } from '../ui.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';
import { waitingOnMe } from '../workflow.js';

export async function renderApprovals(el, { config }) {
  const rows = await api.listRequests(STATUS.SUBMITTED);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const mine = rows.filter(waitingOnMe);
  const others = rows.filter((r) => !waitingOnMe(r));
  const columns = listColumns('approvals', config);
  const sort = rememberedSort('approvals', listSort('approvals', config), columns);

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Approvals</h1>
        ${introText('approvals', '') ? `<p class="page-intro">${introText('approvals', '')}</p>` : ''}
        <p class="subtitle"><span>${rows.length} request${rows.length === 1 ? '' : 's'} awaiting review · ${fmtMoney(total)} total${mine.length ? ` · <strong>${mine.length} waiting on you</strong>` : ''}.</span></p>
      </div>
    </div>
    ${auth.can('request.review') || mine.length ? '' : '<div class="alert alert-info">View only — only a <strong>Chief Engineer</strong> can approve, reject, or request changes.</div>'}
    ${mine.length && others.length ? '<h2 class="section-title">Waiting on you</h2>' : ''}
    <div id="queue"></div>
    ${mine.length && others.length ? '<h2 class="section-title">Waiting on someone else</h2><div id="queue-others"></div>' : ''}`;

  // One list when everything (or nothing) is yours; two when it's split.
  const split = mine.length && others.length;
  const lists = [[el.querySelector('#queue'), split ? mine : rows, 'No requests are waiting for approval.']];
  if (split) lists.push([el.querySelector('#queue-others'), others, '']);
  const draw = () => lists.forEach(([box, list, empty]) => (box.innerHTML = requestTable(list, columns, empty, sort)));
  for (const [box] of lists) bindSorting(box, sort, columns, draw); // one sort for both lists
  draw();
  bindRowLinks(el);
}
