/** App bootstrap: connect to Supabase, load settings + the signed-in user, start the router. */
import { isConfigured } from './supabase.js';
import { api } from './api.js';
import { auth } from './auth.js';
import { startRouter } from './router.js';
import { STATUS, STATUSES, EDITABLE_STATUSES, esc, errorBox } from './ui.js';

const app = document.getElementById('app');

/** Shared config object handed to every view. Mutated in place on reload. */
const config = {};

async function reloadConfig() {
  const settings = await api.getSettings(); // `form` is only readable once signed in
  Object.assign(config, {
    teamName: 'Solar Gators',
    season: '',
    requestIdPrefix: 'SG',
    allowedEmailDomains: [],
    subsystems: [],
    priorities: [],
    defaultPriority: '',
    ...settings.general,
    ...settings.form,
    statuses: STATUSES,
    editableStatuses: EDITABLE_STATUSES,
  });
  document.getElementById('brand-name').textContent = `${config.teamName} Orders`;
  document.title = `${config.teamName} Orders`;
  document.getElementById('footer').textContent = `${config.teamName} · ${config.season} season`;
}

/** Show/hide nav links by permission and fill in the account menu. */
function updateChrome() {
  document.querySelectorAll('[data-perm]').forEach((node) => {
    node.hidden = !auth.signedIn || !node.dataset.perm.split(' ').some((p) => auth.can(p));
  });
  const account = document.getElementById('account-link');
  account.innerHTML = auth.signedIn
    ? `<span class="account-name">${esc(auth.displayName)}</span><span class="account-role">${esc(auth.roleLabel)}</span>`
    : '';
}

async function refreshNavCounts() {
  if (!auth.signedIn) return;
  const set = (id, n) => {
    const badge = document.getElementById(id);
    badge.textContent = n;
    badge.hidden = !n;
  };
  try {
    if (auth.can('request.review')) set('count-approvals', await api.countByStatus(STATUS.SUBMITTED));
    if (auth.can('request.order')) set('count-treasurer', await api.countByStatus(STATUS.APPROVED));
  } catch {
    /* counts are a nice-to-have */
  }
}

async function main() {
  if (!isConfigured) {
    app.innerHTML = `
      <div class="auth-wrap"><div class="auth-card card">
        <h1>Almost there</h1>
        <p>This site isn't connected to a database yet. Add your Supabase project URL and anon key to
        <code>js/site-config.js</code> — see the README's <strong>Setup</strong> section.</p>
      </div></div>`;
    document.body.classList.add('signed-out');
    return;
  }

  try {
    await auth.init(async (event) => {
      await reloadConfig().catch(() => {});
      updateChrome();
      if (event === 'SIGNED_OUT') location.hash = '#/requests';
      render();
    });
    await reloadConfig();
  } catch (err) {
    app.innerHTML = errorBox(new Error(`Could not connect to the database: ${err.message}`));
    return;
  }

  // Remove ?code=… / ?error=… left by email links once Supabase has used them.
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);

  updateChrome();
  const render = startRouter({ config, reloadConfig }, { onRender: () => (updateChrome(), refreshNavCounts()) });
}

main();
