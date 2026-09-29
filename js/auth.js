/**
 * Current user: Supabase session + profile (name, role) + permissions.
 *
 * Permissions come from the database (role_permissions table), so the UI and
 * the server-side checks in supabase/schema.sql always agree. The UI only
 * uses them to decide what to SHOW; the database enforces them.
 */
import { supabase, siteUrl } from './supabase.js';

const state = {
  session: null,
  profile: null,
  permissions: new Set(),
  roles: [],
  recovering: false, // true after opening a password-reset link
};

async function loadProfile() {
  const uid = state.session?.user?.id;
  if (!uid) {
    state.profile = null;
    state.permissions = new Set();
    return;
  }
  const [{ data: profile, error }, { data: roles }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supabase.from('roles').select('*').order('sort'),
  ]);
  if (error) throw error;
  state.profile = profile;
  state.roles = roles || [];
  if (profile) {
    const { data: perms } = await supabase.from('role_permissions').select('permission').eq('role', profile.role);
    state.permissions = new Set((perms || []).map((p) => p.permission));
  }
}

export const auth = {
  get signedIn() {
    return !!state.session;
  },
  /** { id, email, full_name, role } or null */
  get user() {
    return state.profile;
  },
  get displayName() {
    return state.profile?.full_name || state.profile?.email || '';
  },
  get roleLabel() {
    return state.roles.find((r) => r.key === state.profile?.role)?.label || state.profile?.role || '';
  },
  get roles() {
    return state.roles;
  },
  get recovering() {
    return state.recovering;
  },
  can(permission) {
    return state.permissions.has(permission);
  },

  /** Load the current session and re-run `onChange(event)` when it changes. */
  async init(onChange) {
    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    await loadProfile();

    supabase.auth.onAuthStateChange((event, session) => {
      const userChanged = session?.user?.id !== state.session?.user?.id;
      state.session = session;
      if (event === 'PASSWORD_RECOVERY') state.recovering = true;
      // Token refreshes also fire events; only re-render when the user changes.
      // (Supabase advises not awaiting its own calls inside this callback.)
      if (userChanged || event === 'PASSWORD_RECOVERY' || event === 'SIGNED_OUT') {
        setTimeout(async () => {
          await loadProfile().catch(() => {});
          onChange(event);
        }, 0);
      }
    });
  },

  async refresh() {
    await loadProfile();
  },

  async signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  /** Returns true if the user must confirm their email before signing in. */
  async signUp({ email, password, fullName }) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName }, emailRedirectTo: siteUrl() },
    });
    if (error) throw error;
    return !data.session;
  },

  async sendPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
    if (error) throw error;
  },

  async updatePassword(password) {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    state.recovering = false;
  },

  async signOut() {
    await supabase.auth.signOut();
  },
};
