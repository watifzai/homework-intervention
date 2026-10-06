// Shared frontend helpers: API client + small DOM utilities.
// All shared state lives in the server database; nothing is stored in
// localStorage except the remembered class code convenience on registration
// and the UI language preference.

import { t, getLang } from './i18n.js';

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    return d.toLocaleDateString(getLang() === 'ms' ? 'ms-MY' : undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

export function fmtPct(score) {
  if (score === null || score === undefined) return null;
  return Math.round(score * 100) + '%';
}

// Loading / empty / error states
export const loadingState = (msg = t('common.loading')) =>
  el('div', { class: 'loading' }, el('span', { class: 'spinner', role: 'status', 'aria-label': 'Loading' }), msg);

export const emptyState = (msg) =>
  el('div', { class: 'state' }, msg);

export const errorState = (msg, retry) =>
  el('div', { class: 'state' },
    el('div', { class: 'alert error', role: 'alert' }, msg),
    retry ? el('button', { class: 'btn secondary', onclick: retry }, t('common.tryAgain')) : null);

export function alertBox(kind, msg) {
  return el('div', { class: `alert ${kind}`, role: 'alert' }, msg);
}

export function levelName(level) {
  return t('level.' + level);
}

export function levelBadge(level) {
  if (!level) return el('span', { class: 'badge warn' }, t('level.set'));
  // Each learning level owns one system accent: amber / emerald / blue.
  return el('span', { class: `badge level-${level}` }, levelName(level));
}

export function statusBadge(status) {
  const map = {
    not_started: 'muted',
    in_progress: 'warn',
    submitted: 'ok',
    overdue: 'bad',
  };
  const cls = map[status] || 'muted';
  return el('span', { class: `badge ${cls}` }, t('status.' + status));
}

export function demoBadge() {
  return el('span', { class: 'badge demo', title: 'Demo data (separate from real class records)' }, t('common.demo'));
}

// --- homework pictures -------------------------------------------------------
// A picture value is usually an emoji string, but may also be a reference to
// an uploaded image (/img/<id>) or an external http(s) link. Only those two
// shapes are ever rendered as <img>; anything else stays plain text.
export function isImageRef(v) {
  return typeof v === 'string'
    && (/^\/img\/[0-9a-f]{16}$/.test(v) || /^https?:\/\/\S+$/i.test(v));
}

// Returns an <img> node for image references, or null for emoji/text so call
// sites can fall back to the string itself.
export function picNode(value, cls = 'pic-inline') {
  if (!isImageRef(value)) return null;
  return el('img', { class: cls, src: value, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
}

// Uploads an image file and resolves to its /img/<id> reference. Teacher
// sessions only — the server enforces it.
export async function uploadImage(file) {
  const res = await fetch('/api/teacher/images', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.url;
}
