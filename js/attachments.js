/**
 * Files & links (migration 017), shared by sponsor cards, requests and Finances rows.
 * Stays out of the way: with nothing attached it's one small "📎 Add a file or link"
 * line (or nothing, for people who can't add); the add form only opens when asked.
 * Files go to a private storage bucket (10 MB each); links are just saved.
 */
import { api } from './api.js';
import { esc, fmtDate, errorBox } from './ui.js';

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpeg|gif|webp|svg\+xml)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\..+|vnd\.ms-(excel|powerpoint)|postscript|illustrator|zip)|text\/(plain|csv))$/;

const sizeText = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const kindText = (a) => {
  if (a.url) return 'Link';
  const ext = (a.file_name.split('.').pop() || '').toUpperCase();
  return ext.length <= 5 ? ext : 'File';
};
const isImage = (a) => /^image\//.test(a.mime) && a.href;

/**
 * Show the files of one owner in `box`. Options: kind ('sponsor' | 'request' | 'finance'),
 * ownerId, canEdit, hint (placeholder text for the empty state, e.g. "Attach a quote or receipt"),
 * onChange(count) after adding / removing (e.g. to update a 📎 badge), framed (show as a card).
 */
export async function renderAttachments(box, { kind, ownerId, canEdit, hint = 'Add a file or link', onChange, framed = false }) {
  let list = await api.listAttachments(kind, ownerId);
  if (list === null) {
    box.innerHTML = ''; // before migration 017
    return;
  }
  let adding = false;

  const draw = () => {
    if (!list.length && !canEdit) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `<div class="attachments ${framed ? 'card' : ''} ${list.length ? '' : 'is-empty'}">
      ${list.length ? `<div class="attach-head"><strong>Files &amp; links</strong> <span class="muted small">(${list.length})</span></div>
        <ul class="attach-list">${list
          .map(
            (a) => `<li>
              ${isImage(a) ? `<a href="${esc(a.href)}" target="_blank" rel="noopener" class="attach-thumb"><img src="${esc(a.href)}" alt=""></a>` : `<span class="attach-icon" aria-hidden="true">${a.url ? '🔗' : '📄'}</span>`}
              <span class="attach-text">
                ${a.href ? `<a href="${esc(a.href)}" target="_blank" rel="noopener">${esc(a.label || a.file_name || a.url)}</a>` : `<span>${esc(a.label || a.file_name)}</span> <span class="muted small">(unavailable)</span>`}
                <span class="muted small">${esc([kindText(a), sizeText(a.size), a.uploaded_by_name, fmtDate(a.created_at)].filter(Boolean).join(' · '))}</span>
              </span>
              ${canEdit ? `<button type="button" class="icon-btn" data-remove-attachment="${esc(a.id)}" aria-label="Remove ${esc(a.label || a.file_name || 'link')}" title="Remove">&times;</button>` : ''}
            </li>`
          )
          .join('')}</ul>` : ''}
      ${canEdit && !adding ? `<button type="button" class="link-btn attach-open">📎 ${list.length ? 'Add another' : esc(hint)}</button>` : ''}
      ${canEdit && adding ? `<div class="attach-form">
        <label class="attach-drop">
          <input type="file" multiple class="attach-file">
          <span><strong>Choose files</strong> or drop them here <span class="muted small">(PDF, images, Office files; up to 10 MB each)</span></span>
        </label>
        <input type="text" class="attach-label" maxlength="120" placeholder="Label (optional), e.g. Signed agreement 2026">
        <div class="attach-link-row">
          <input type="url" class="attach-url" placeholder="…or paste a link (Google Drive, OneDrive, Canva)">
          <button type="button" class="btn btn-sm attach-add-link">Add link</button>
        </div>
        <p class="hint">Don't upload W-9s, tax IDs or bank details.</p>
        <button type="button" class="link-btn attach-close">Done</button>
      </div>` : ''}
      <div class="attach-status muted small" aria-live="polite"></div>
      <div class="attach-errors"></div>
    </div>`;
  };

  const refresh = async () => {
    list = (await api.listAttachments(kind, ownerId)) || [];
    draw();
    onChange?.(list.length);
  };
  const status = (t) => {
    const s = box.querySelector('.attach-status');
    if (s) s.textContent = t;
  };
  const fail = (err) => {
    const e = box.querySelector('.attach-errors');
    if (e) e.innerHTML = errorBox(err);
  };

  const upload = async (files) => {
    const label = box.querySelector('.attach-label')?.value.trim() || '';
    const problems = [];
    let done = 0;
    for (const file of files) {
      if (file.size > MAX_SIZE) problems.push(`"${file.name}" is over 10 MB.`);
      else if (!ALLOWED.test(file.type)) problems.push(`"${file.name}" isn't a file type that can be attached (PDF, images, Office files, text, zip).`);
      else {
        status(`Uploading ${file.name}…`);
        try {
          await api.uploadAttachment(kind, ownerId, file, files.length === 1 ? label : '');
          done++;
        } catch (err) {
          problems.push(err.message);
        }
      }
    }
    adding = problems.length > 0;
    await refresh();
    status(done ? `Added ${done} file${done === 1 ? '' : 's'}.` : '');
    if (problems.length) fail(Object.assign(new Error('Some files weren\'t added:'), { details: problems }));
  };

  box.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('attach-open')) {
      adding = true;
      draw();
      box.querySelector('.attach-file')?.focus();
    } else if (t.classList.contains('attach-close')) {
      adding = false;
      draw();
    } else if (t.classList.contains('attach-add-link')) {
      const url = box.querySelector('.attach-url').value.trim();
      if (!/^https?:\/\/\S+$/.test(url)) return fail(new Error('Paste a full link starting with https://'));
      try {
        await api.addAttachmentLink(kind, ownerId, url, box.querySelector('.attach-label').value.trim());
        adding = false;
        await refresh();
      } catch (err) {
        fail(err);
      }
    } else if (t.dataset.removeAttachment) {
      const a = list.find((x) => x.id === t.dataset.removeAttachment);
      if (!confirm(`Remove "${a.label || a.file_name || a.url}"?`)) return;
      try {
        await api.deleteAttachment(a.id);
        await refresh();
      } catch (err) {
        fail(err);
      }
    }
  };
  box.onchange = (e) => {
    if (e.target.classList.contains('attach-file') && e.target.files.length) upload([...e.target.files]);
  };
  box.ondragover = (e) => {
    if (!canEdit || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    box.classList.add('is-dropping');
  };
  box.ondragleave = () => box.classList.remove('is-dropping');
  box.ondrop = (e) => {
    if (!canEdit || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    box.classList.remove('is-dropping');
    upload([...e.dataTransfer.files]);
  };

  draw();
}

/** A small "📎 Files" pop-up for places without room for the panel (a Finances row). */
export function openAttachmentsDialog({ title, ...options }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'card calc-dialog';
  dialog.innerHTML = `<h2>${esc(title)}</h2><div class="dialog-attachments"></div>
    <div class="form-actions"><button type="button" class="btn" data-close>Close</button></div>`;
  document.body.appendChild(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.querySelector('[data-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', close);
  dialog.showModal();
  renderAttachments(dialog.querySelector('.dialog-attachments'), { ...options, hint: options.hint || 'Add a receipt, invoice or link' });
}
