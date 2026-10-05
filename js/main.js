/** App bootstrap: connect to Supabase, load settings + the signed-in user, start the router. */
import { isConfigured } from './supabase.js';
import { api, setNotificationsOn } from './api.js';
import { auth } from './auth.js';
import { startRouter } from './router.js';
import { hasHelp } from './views/help.js';
import { STATUS, STATUSES, EDITABLE_STATUSES, esc, errorBox, setCurrentSeason, setAppearance, renderRichText } from './ui.js';

const app = document.getElementById('app');

// Bump when adding a file to supabase/migrations/ (the migration sets general.schemaVersion).
const REQUIRED_SCHEMA_VERSION = 15;
const MIGRATIONS = { 2: '002_form_fields.sql', 3: '003_archive_and_import.sql', 4: '004_cost_adjustments.sql', 5: '005_editable_permissions.sql', 6: '006_seasons.sql', 7: '007_one_vendor_per_request.sql', 8: '008_roles_admin_history.sql', 9: '009_form_rules_layout_exports.sql', 10: '010_workflow_budgets_notifications.sql', 11: '011_notification_choices.sql', 12: '012_link_imported_requests.sql', 13: '013_history_drafts_ticket.sql', 14: '014_finances.sql', 15: '015_sponsors.sql' };

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
    lists: settings.lists || {}, // Admin → Display → Request lists
    appearance: settings.appearance || {}, // Admin → Display → Colors & logo, Text & banner
    layout: settings.layout || {}, // Admin → Request page
    exports: settings.exports || {}, // Admin → Display → Excel templates
    workflow: settings.workflow || {}, // Admin → Workflow (rules, budgets)
    notifications: settings.notifications || {}, // Admin → Notifications
    sponsors: settings.sponsors || {}, // Sponsors board: stages, kinds, income sheet
  });
  document.title = `${config.teamName} Orders`;
  setCurrentSeason(config.season);
  setNotificationsOn(config.notifications.enabled);
  setAppearance(config.appearance, { defaultPriority: config.defaultPriority });
  applyBranding();
  document.getElementById('footer').textContent = `${config.teamName} · ${config.season} season`;
}

/** Logo and accent color from Admin → Display → Colors & logo (also shown on the sign-in page). */
function applyBranding() {
  const a = config.appearance || {};
  document.querySelector('.brand-logo').src = a.logo || 'assets/solar-gators-logo.png';
  const root = document.documentElement.style;
  if (/^#[0-9a-f]{6}$/i.test(a.accent || '')) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(a.accent.slice(i, i + 2), 16));
    const darker = `#${[r, g, b].map((c) => Math.round(c * 0.85).toString(16).padStart(2, '0')).join('')}`;
    root.setProperty('--orange', a.accent);
    root.setProperty('--orange-dark', darker);
    root.setProperty('--focus', `${a.accent}55`);
  } else {
    ['--orange', '--orange-dark', '--focus'].forEach((v) => root.removeProperty(v));
  }
}

/** Announcement banner (Admin → Text & banner) — hidden after its end date. */
function updateAnnouncement() {
  const box = document.getElementById('announcement');
  const ann = config.appearance?.announcement;
  const today = new Date().toISOString().slice(0, 10);
  const show = auth.signedIn && ann?.text && (!ann.until || today <= ann.until);
  box.hidden = !show;
  box.className = show ? `announcement announcement-${['info', 'warning', 'success', 'error'].includes(ann.tone) ? ann.tone : 'info'}` : 'announcement';
  box.innerHTML = show ? `<div class="container">${renderRichText(ann.text)}</div>` : '';
}

/** Show/hide nav links by permission and fill in the account menu. */
function updateChrome() {
  document.querySelectorAll('.topbar [data-perm]').forEach((node) => {
    node.hidden = !auth.signedIn || !node.dataset.perm.split(' ').some((p) => auth.can(p));
  });
  // Help tab only when the team has written help text.
  document.getElementById('nav-help').hidden = !auth.signedIn || !hasHelp(config);
  updateAnnouncement();
  // Tell leads (only) when the live database is missing a migration.
  const banner = document.getElementById('banner');
  const version = Number(config.schemaVersion) || 1;
  const missing = Object.entries(MIGRATIONS).filter(([v]) => Number(v) > version).map(([, file]) => file);
  banner.hidden = !(auth.signedIn && auth.can('settings.edit') && version < REQUIRED_SCHEMA_VERSION);
  banner.innerHTML = banner.hidden
    ? ''
    : `<div class="container"><strong>Database update needed.</strong> In Supabase → SQL Editor, run
       ${missing.map((f) => `<code>supabase/migrations/${esc(f)}</code>`).join(', then ')} from the GitHub repo.
       Until then, new features may not save correctly.</div>`;

  const account = document.getElementById('account-btn');
  account.innerHTML = auth.signedIn
    ? `<span class="account-name">${esc(auth.displayName)}</span><span class="account-role">${esc(auth.roleLabel)}</span>`
    : '';
}

async function refreshNavCounts() {
  if (!auth.signedIn) return;
  let total = 0;
  const set = (id, n) => {
    const badge = document.getElementById(id);
    badge.textContent = n;
    badge.hidden = !n;
    if (id !== 'count-menu') total += n;
  };
  try {
    // Queue: what's waiting on you: approvals for reviewers, ordering for the Treasurer.
    const queue = [
      auth.can('request.review') ? await api.countByStatus(STATUS.SUBMITTED) : 0,
      auth.can('request.order') ? await api.countByStatus(STATUS.APPROVED) : 0,
    ];
    set('count-queue', queue[0] + queue[1]);
    set('count-requests', await api.countMyChangesRequested(auth.user.id)); // yours to fix
    set('count-menu', total); // the folded menu on phones shows the sum
  } catch {
    /* counts are a nice-to-have */
  }
}

/**
 * Phones and tablets: the Menu button opens the page links. Everywhere: your name
 * opens the account menu (My account, Help, Sign out). Picking something, tapping
 * elsewhere or Escape closes them.
 */
function setMenu(open) {
  document.body.classList.toggle('nav-open', open);
  document.getElementById('menu-btn').setAttribute('aria-expanded', String(open));
}
function setAccountMenu(open) {
  document.getElementById('account-pop').hidden = !open;
  document.getElementById('account-btn').setAttribute('aria-expanded', String(open));
}
const closeMenus = () => (setMenu(false), setAccountMenu(false));
function bindMenu() {
  document.getElementById('menu-btn').addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
  document.getElementById('account-btn').addEventListener('click', () => setAccountMenu(document.getElementById('account-pop').hidden));
  document.getElementById('menu-sign-out').addEventListener('click', () => (closeMenus(), auth.signOut()));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-btn, #main-nav')) setMenu(false);
    if (!e.target.closest('.account-menu') || e.target.closest('#account-pop a')) setAccountMenu(false);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());
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
      if (event === 'SIGNED_OUT') location.hash = '#/home';
      render();
    });
    await reloadConfig();
  } catch (err) {
    app.innerHTML = errorBox(new Error(`Could not connect to the database: ${err.message}`));
    return;
  }

  // Remove ?code=… / ?error=… left by email links once Supabase has used them.
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);

  bindMenu();
  updateChrome();
  const render = startRouter({ config, reloadConfig }, { onRender: () => (closeMenus(), updateChrome(), refreshNavCounts()) });
}

main();
