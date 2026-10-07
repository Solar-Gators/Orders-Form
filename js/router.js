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
import { renderUsers, renderRoles, renderDropdowns, renderSeason, renderFormFields, ADMIN_TABS } from './views/admin.js';
import { renderAppearance, renderHistory } from './views/adminSetup.js';
import { renderDisplay, renderTextBanner } from './views/adminPages.js';
import { renderWorkflow, renderNotifications } from './views/adminWorkflow.js';
import { renderHelp } from './views/help.js';
import { renderHome } from './views/home.js';
import { renderRequestForm } from './views/requestForm.js';
import { renderRequestList } from './views/requestList.js';
import { renderRequestDetail } from './views/requestDetail.js';
import { renderApprovals } from './views/approvals.js';
import { renderTreasurer } from './views/treasurer.js';
import { renderFinances } from './views/finances.js';
import { renderSponsors, renderSponsorCard } from './views/sponsors.js';
import { renderExport } from './views/exportPage.js';
import { renderArchive } from './views/archive.js';
import { errorBox } from './ui.js';
import { confirmLeave } from './leaveGuard.js';

// Either workflow permission lets you view both queues (actions are still limited by role).
const LEADS = ['request.review', 'request.order'];

const tabPerms = (name) => ADMIN_TABS.find(([key]) => key === name)[2];

const ROUTES = [
  { pattern: /^\/home$/, nav: 'home', view: renderHome },
  { pattern: /^\/new$/, nav: 'new', view: renderRequestForm },
  { pattern: /^\/requests$/, nav: 'requests', view: renderRequestList },
  { pattern: /^\/requests\/([^/]+)\/edit$/, nav: 'requests', view: renderRequestForm },
  // "Order again": a new request pre-filled from this one.
  { pattern: /^\/requests\/([^/]+)\/again$/, nav: 'new', view: renderRequestForm, copy: true },
  { pattern: /^\/requests\/([^/]+)$/, nav: 'requests', view: renderRequestDetail },
  { pattern: /^\/approvals$/, nav: 'queue', view: renderApprovals, perm: LEADS },
  { pattern: /^\/treasurer$/, nav: 'queue', view: renderTreasurer, perm: LEADS },
  // Queue opens on what you do: ordering for the Treasurer, approving for everyone else.
  { pattern: /^\/queue$/, redirect: () => (auth.can('request.order') && !auth.can('request.review') ? '#/treasurer' : '#/approvals') },
  { pattern: /^\/finances$/, nav: 'finances', view: renderFinances, perm: ['finances.view', 'finances.edit'] },
  { pattern: /^\/sponsors$/, nav: 'sponsors', view: renderSponsors, perm: ['sponsors.view', 'sponsors.edit'] },
  { pattern: /^\/sponsors\/([^/]+)$/, nav: 'sponsors', view: renderSponsorCard, perm: ['sponsors.view', 'sponsors.edit'] },
  { pattern: /^\/archive$/, nav: 'requests', view: renderArchive },
  { pattern: /^\/export$/, nav: 'requests', view: renderExport },
  { pattern: /^\/admin\/users$/, nav: 'admin', view: renderUsers, perm: tabPerms('users') },
  { pattern: /^\/admin\/fields$/, nav: 'admin', view: renderFormFields, perm: tabPerms('fields') },
  { pattern: /^\/admin\/roles$/, nav: 'admin', view: renderRoles, perm: tabPerms('roles') },
  { pattern: /^\/admin\/dropdowns$/, nav: 'admin', view: renderDropdowns, perm: tabPerms('dropdowns') },
  { pattern: /^\/admin\/season$/, nav: 'admin', view: renderSeason, perm: tabPerms('season') },
  // The old Settings page is now Dropdowns & rules + Team & season.
  { pattern: /^\/admin\/settings$/, redirect: () => (auth.can('settings.edit') ? '#/admin/dropdowns' : '#/admin/season') },
  { pattern: /^\/admin\/display(?:\/(lists|page|exports))?$/, nav: 'admin', view: renderDisplay, perm: tabPerms('display') },
  // Old addresses of what are now sections of "Lists, layout & Excel", and Import (in Team & season).
  { pattern: /^\/admin\/(lists|page|exports)$/, redirect: () => `#/admin/display/${location.hash.split('/').pop()}` },
  { pattern: /^\/admin\/import$/, redirect: () => '#/admin/season' },
  { pattern: /^\/admin\/appearance$/, nav: 'admin', view: renderAppearance, perm: tabPerms('appearance') },
  { pattern: /^\/admin\/text$/, nav: 'admin', view: renderTextBanner, perm: tabPerms('text') },
  { pattern: /^\/admin\/workflow$/, nav: 'admin', view: renderWorkflow, perm: tabPerms('workflow') },
  { pattern: /^\/admin\/notifications$/, nav: 'admin', view: renderNotifications, perm: tabPerms('notifications') },
  { pattern: /^\/help$/, nav: 'help', view: renderHelp },
  { pattern: /^\/admin\/history(?:\/([\w,]+))?$/, nav: 'admin', view: renderHistory, perm: tabPerms('history') },
  // "Admin" opens the first tab this person can use.
  { pattern: /^\/admin$/, redirect: () => `#/admin/${(ADMIN_TABS.find(([, , perms, , hidden]) => !hidden && perms.some((p) => auth.can(p))) || ['users'])[0]}` },
  { pattern: /^\/account$/, nav: 'account', view: renderAccount },
  { pattern: /^\/reset-password$/, view: renderResetPassword },
];

let renderToken = 0;

export function startRouter(ctx, { onRender } = {}) {
  const render = async () => {
    const token = ++renderToken;
    // No address (the site was just opened): Home is the default page.
    const path = location.hash.replace(/^#/, '') || '/home';
    let route = ROUTES.find((r) => r.pattern.test(path));

    if (auth.signedIn && auth.recovering) route = { view: renderResetPassword };
    else if (!auth.signedIn) route = { view: renderLogin, bare: true };
    else if (!route) {
      location.hash = '#/home';
      return;
    } else if (route.redirect) {
      location.hash = route.redirect();
      return;
    }

    document.body.classList.toggle('signed-out', !auth.signedIn);
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.nav));

    const match = route.pattern ? path.match(route.pattern) : [];
    const params = { id: match?.[1] ? decodeURIComponent(match[1]) : null, copy: !!route.copy };

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

  // Leaving a page with unsaved changes asks first; "Stay" puts the address back.
  let currentHash = location.hash;
  let reverting = false;
  window.addEventListener('hashchange', () => {
    if (reverting) {
      reverting = false;
      return;
    }
    if (!confirmLeave()) {
      reverting = true;
      location.hash = currentHash;
      return;
    }
    currentHash = location.hash;
    render();
    window.scrollTo(0, 0);
  });
  render();
  return render;
}
