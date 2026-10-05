/**
 * Home (#/home): the landing page and the site's default page. Also opened by
 * clicking the logo or "Orders" in the header.
 * A welcome, what needs you right now, your latest requests, and how ordering works.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, esc, fmtDate, fmtMoney, statusBadge, takeFlash, introText } from '../ui.js';
import { shippingPerRequest } from '../formFields.js';
import { hasHelp } from './help.js';
import { sponsorFollowUps } from './sponsors.js';

export async function renderHome(el, { config }) {
  const me = auth.user.id;
  const reviews = auth.can('request.review');
  const orders = auth.can('request.order');
  const [mine, recent, waiting, toOrder, onTheWay, followUps] = await Promise.all([
    api.listMyUnfinished(me),
    api.listMyRecent(me, 5),
    reviews || orders ? api.countByStatus(STATUS.SUBMITTED) : 0,
    reviews || orders ? api.countByStatus(STATUS.APPROVED) : 0,
    orders ? api.countByStatus(STATUS.ORDERED) : 0,
    sponsorFollowUps(config),
  ]);

  const first = (auth.displayName || '').trim().split(/\s+/)[0];
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // What needs you: your own requests first, then the queues your role works.
  const tasks = [
    ...[...mine]
      .sort((a, b) => (a.status === b.status ? 0 : a.status === STATUS.CHANGES_REQUESTED ? -1 : 1))
      .map((r) => ({
        href: `#/requests/${r.request_number}`,
        title: r.title || 'Untitled request',
        note: r.status === STATUS.CHANGES_REQUESTED
          ? `${r.latest_approval?.approver || 'A reviewer'} asked for changes`
          : 'Draft: not submitted yet',
        badge: statusBadge(r.status),
      })),
    ...(reviews && waiting ? [{ href: '#/approvals', title: `${plural(waiting, 'request')} waiting for approval`, note: 'Queue', count: waiting }] : []),
    ...(orders && toOrder ? [{ href: '#/treasurer', title: `${plural(toOrder, 'approved request')} to order`, note: 'Queue', count: toOrder }] : []),
    ...(orders && onTheWay ? [{ href: '#/treasurer', title: `${plural(onTheWay, 'order')} awaiting delivery`, note: 'Queue', count: onTheWay }] : []),
    ...followUps.map((c) => ({ href: `#/sponsors/${c.id}`, title: `Follow up with ${c.name}`, note: `Sponsors · due ${fmtDate(c.follow_up)}` })),
  ];

  const steps = [
    ['Make a request', `Say what you need and why, with one row per item${config.oneVendorPerRequest !== false ? ' from a single vendor' : ''}.${
      shippingPerRequest(config) ? ' Enter shipping once for the whole order.' : ''}`],
    ['It gets approved', 'A Chief Engineer approves it, or sends it back with a note so you can fix it and resubmit.'],
    ['The Treasurer orders it', 'Approved requests are ordered through the department. You can see the ticket number on the request.'],
    ['It arrives', "The request is marked Received when it's delivered. Everything stays searchable in Requests and the Archive."],
  ];

  el.innerHTML = `
    ${takeFlash()}
    <section class="home-hero">
      <div class="home-hero-text">
        <p class="eyebrow">${esc(config.teamName)} · ${esc(config.season)} season</p>
        <h1>${first ? `Hi ${esc(first)}, welcome to Orders` : 'Welcome to Orders'}</h1>
        <p class="home-lead">${introText('home', 'Request parts for the team and follow them through approval, ordering and delivery.')}</p>
      </div>
      <div class="home-actions">
        <a class="btn btn-primary btn-lg" href="#/new">+ New Request</a>
        <a class="btn btn-lg" href="#/requests">All requests</a>
      </div>
    </section>

    <div class="home-grid">
      <div class="home-main">
        <section class="card">
          <h2>Needs your attention</h2>
          ${
            tasks.length
              ? `<ul class="task-list">${tasks
                  .map(
                    (t) => `<li><a href="${esc(t.href)}">
                      ${t.count ? `<span class="task-count">${t.count}</span>` : ''}
                      <span class="task-text"><strong>${esc(t.title)}</strong><span class="muted small">${esc(t.note)}</span></span>
                      ${t.badge || '<span class="task-go" aria-hidden="true">→</span>'}
                    </a></li>`
                  )
                  .join('')}</ul>`
              : '<p class="muted all-clear">You\'re all caught up. Nothing is waiting on you.</p>'
          }
        </section>

        <section class="card">
          <div class="card-head"><h2>Your latest requests</h2>${recent.length ? '<a class="small" href="#/requests">See all</a>' : ''}</div>
          ${
            recent.length
              ? `<ul class="recent-list">${recent
                  .map(
                    (r) => `<li><a href="#/requests/${esc(r.request_number)}">
                      <span class="recent-title"><strong>${esc(r.title || 'Untitled request')}</strong>
                        <span class="muted small">${esc(r.request_number)} · ${fmtDate(r.created_at)} · ${fmtMoney(r.total)}</span></span>
                      ${statusBadge(r.status)}
                    </a></li>`
                  )
                  .join('')}</ul>`
              : `<p class="muted">You haven't made a request yet.</p><a class="btn btn-primary" href="#/new">Start your first request</a>`
          }
        </section>
      </div>

      <section class="card home-steps">
        <h2>How ordering works</h2>
        <ol class="steps">${steps.map(([t, d]) => `<li><strong>${esc(t)}</strong><span>${esc(d)}</span></li>`).join('')}</ol>
        <p class="muted small">${hasHelp(config) ? 'Questions? Read the <a href="#/help">Help page</a>. ' : ''}You can come back here any time by clicking the logo.</p>
      </section>
    </div>`;
}
