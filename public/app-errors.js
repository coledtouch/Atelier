// Settings → Advanced diagnostics → Recent app errors: the owner's view of GET /api/client-error (src/client-errors.js),
// the start-up failures and uncaught errors the boot watchdog in index.html (#bootWatch) reported from any device.
// Every value goes into the page as text (textContent), never as HTML, whatever the server sends back.

export const KIND_LABELS = Object.freeze({
  load: 'Didn’t load', error: 'Uncaught error', rejection: 'Unhandled promise', boot: 'Start failed', stall: 'Stalled while opening',
});
// A load report with net: true saw no server error (a dropped connection, most likely; Safari can't tell either way).
export const NET_LABEL = 'Didn’t download';
export const PHASE_LABELS = Object.freeze({ loading: 'loading files', starting: 'starting', running: 'running' });

const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');
const whole = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);

/** One report → the plain strings a row shows (`locale` and `timeZone` pin the date for tests). */
export function reportRow(r, { locale, timeZone } = {}) {
  if (!r || typeof r !== 'object') return null;
  const line = whole(r.line), col = whole(r.col), count = whole(r.count) || 1, at = whole(r.lastAt);
  const where = str(r.file) ? `${str(r.file)}${line != null ? `:${line}${col != null ? `:${col}` : ''}` : ''}` : 'no file named';
  let when = '';
  if (at) {
    try { when = new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }); } catch {}
  }
  return {
    title: `${r.kind === 'load' && r.net === true ? NET_LABEL : KIND_LABELS[r.kind] || 'Error'} · ${str(r.name, 48) || 'Error'}`,
    where,
    meta: [`v${str(r.v, 6) || '?'}`, str(r.platform, 24), PHASE_LABELS[r.phase] || '', r.online === false ? 'offline' : '', count > 1 ? `×${count}` : '', when].filter(Boolean).join(' · '),
    stack: Array.isArray(r.stack) ? r.stack.filter((f) => typeof f === 'string').slice(0, 6).map((f) => f.slice(0, 100)) : [],
  };
}

/** Fills `box` with the list (or a one-line note). data: the GET's JSON, {reports, days}. */
export function renderAppErrors(box, data, opts = {}) {
  const doc = box.ownerDocument;
  const make = (tag, cls, text) => { const x = doc.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x; };
  const rows = (Array.isArray(data?.reports) ? data.reports : []).map((r) => reportRow(r, opts)).filter(Boolean);
  const days = whole(data?.days) || 30;
  box.replaceChildren();
  if (!rows.length) { box.append(make('p', 'ae-empty', `No app errors reported in the last ${days} days.`)); return 0; }
  const list = make('ul', 'ae-list');
  for (const row of rows) {
    const li = make('li', 'ae-row');
    li.append(make('span', 'ae-title', row.title), make('span', 'ae-where', row.where), make('span', 'ae-meta', row.meta));
    if (row.stack.length > 1) {
      const more = make('details', 'ae-stack');
      more.append(make('summary', '', `${row.stack.length} frames`), make('span', 'ae-frames', row.stack.join('\n')));
      li.append(more);
    }
    list.append(li);
  }
  box.append(list, make('p', 'ae-foot', `Newest first · kept ${days} days · only the version, error name, file, line and device type; never what was typed.`));
  return rows.length;
}

/** GET /api/client-error with the owner's headers → the JSON, or throws an Error with the server's message. */
export async function loadAppErrors(headers, fetchFn = globalThis.fetch) {
  const r = await fetchFn('/api/client-error', { headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `Couldn’t load app errors (${r.status}).`);
  return j;
}
