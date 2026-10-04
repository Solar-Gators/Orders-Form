/**
 * "You have unsaved changes" — for the request form and the Admin editors.
 * A page registers itself with guardLeaving(el, isDirty); the router asks
 * confirmLeave() before switching pages, and closing/reloading the tab asks
 * the browser's own question. The guard ends when the page is replaced.
 */
let current = null; // { el, isDirty }

const active = () => (current && document.body.contains(current.el) ? current : null);

/** Ask before leaving `el`'s page while isDirty() is true. */
export function guardLeaving(el, isDirty) {
  current = { el, isDirty };
}

/** Stop asking (e.g. right after saving, before navigating away). */
export function releaseGuard() {
  current = null;
}

/** True if it's fine to leave: nothing unsaved, or the person confirmed. */
export function confirmLeave() {
  const g = active();
  if (!g || !g.isDirty()) {
    current = null;
    return true;
  }
  if (window.confirm('You have unsaved changes. Leave this page without saving them?')) {
    current = null;
    return true;
  }
  return false;
}

window.addEventListener('beforeunload', (e) => {
  if (active()?.isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
