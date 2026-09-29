/**
 * Minimal hash router: "#/path" -> view function.
 * Each view is `async (el, ctx) => void` where
 *   ctx = { config, params, rerender, reloadConfig }.
 *
 * Signed-out users always get the sign-in page. Routes with `perm` are only
 * shown to users whose role has at least one of those permissions. Leads (CE
 * and Treasurer) can view both workflow queues, but each page only offers the
 * actions their role allows; the database enforces the same rules.
 */
import { auth } from './auth.js';
import { renderLogin } from './views/login.js';
import { renderAccount, renderResetPassword } from './views/account.js';
import { renderUsers, renderSettings, renderFormFields } from './views/admin.js';
import { renderRequestForm } from './views/requestForm.js';
import { renderRequestList } from './views/requestList.js';
import { renderRequestDetail } from './views/requestDetail.js';
import { renderApprovals } from './views/approvals.js';
import { renderTreasurer } from './views/treasurer.js';
import { renderExport } from './views/exportPage.js';
import { renderArchive } from './views/archive.js';
import { renderImport } from './views/importPage.js';
import { errorBox } from './ui.js';

// Either workflow permission lets you view both queues (actions are still limited by role).
const LEADS = ['request.review', 'request.order'];

const ROUTES = [
  { pattern: /^\/new$/, nav: 'new', view: renderRequestForm },
  { pattern: /^\/requests$/, nav: 'requests', view: renderRequestList },
  { pattern: /^\/requests\/([^/]+)\/edit$/, nav: 'requests', view: renderRequestForm },
  { pattern: /^\/requests\/([^/]+)$/, nav: 'requests', view: renderRequestDetail },
  { pattern: /^\/approvals$/, nav: 'approvals', view: renderApprovals, perm: LEADS },
  { pattern: /^\/treasurer$/, nav: 'treasurer', view: renderTreasurer, perm: LEADS },
  { pattern: /^\/archive$/, nav: 'archive', view: renderArchive },
  { pattern: /^\/export$/, nav: 'export', view: renderExport },
  { pattern: /^\/admin\/users$/, nav: 'admin', view: renderUsers, perm: ['users.manage'] },
  { pattern: /^\/admin\/fields$/, nav: 'admin', view: renderFormFields, perm: ['settings.edit'] },
  { pattern: /^\/admin\/import$/, nav: 'admin', view: renderImport, perm: ['settings.edit'] },
  { pattern: /^\/admin\/settings$/, nav: 'admin', view: renderSettings, perm: ['settings.edit'] },
  { pattern: /^\/admin$/, redirect: () => (auth.can('users.manage') ? '#/admin/users' : '#/admin/settings') },
  { pattern: /^\/account$/, nav: 'account', view: renderAccount },
  { pattern: /^\/reset-password$/, view: renderResetPassword },
];

let renderToken = 0;

export function startRouter(ctx, { onRender } = {}) {
  const render = async () => {
    const token = ++renderToken;
    const path = location.hash.replace(/^#/, '') || '/requests';
    let route = ROUTES.find((r) => r.pattern.test(path));

    if (auth.signedIn && auth.recovering) route = { view: renderResetPassword };
    else if (!auth.signedIn) route = { view: renderLogin, bare: true };
    else if (!route) {
      location.hash = '#/requests';
      return;
    } else if (route.redirect) {
      location.hash = route.redirect();
      return;
    }

    document.body.classList.toggle('signed-out', !auth.signedIn);
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.nav));

    const match = route.pattern ? path.match(route.pattern) : [];
    const params = { id: match?.[1] ? decodeURIComponent(match[1]) : null };

    // Render into a detached element so a slow, stale view can't overwrite a newer one.
    const el = document.createElement('div');
    try {
      if (route.perm && !route.perm.some((p) => auth.can(p))) {
        el.innerHTML = `<div class="alert alert-info">Your role (${auth.roleLabel}) doesn't have access to this page.</div>`;
      } else {
        await route.view(el, { ...ctx, params, rerender: render });
      }
    } catch (err) {
      el.innerHTML = errorBox(err);
    }
    if (token !== renderToken) return;
    document.getElementById('app').replaceChildren(el);
    onRender?.();
  };

  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });
  render();
  return render;
}
