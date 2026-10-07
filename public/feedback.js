// A voluntary feedback form: no automatic screenshots, prompt collection or account details.
const MAX_SCREENSHOT = 350 * 1024;
const MODES = new Set(['ask', 'code', 'image', 'video', 'ideas', 'build']);
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LABELS = { bug: 'Bug', confusing: 'Confusing', suggestion: 'Suggestion' };
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function feedbackDiagnostics(context = {}, viewport = {}) {
  const doc = {};
  if (MODES.has(context.mode)) doc.mode = context.mode;
  if (typeof context.version === 'string' && /^v?\d{1,4}$/.test(context.version)) doc.version = context.version;
  if (typeof context.online === 'boolean') doc.online = context.online;
  const { width, height } = viewport;
  if ([width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 10000)) doc.viewport = { width, height };
  return Object.keys(doc).length ? doc : null;
}

export function screenshotProblem(file) {
  if (!file) return '';
  if (!TYPES.has(file.type)) return 'Choose a PNG, JPEG or WebP screenshot.';
  if (!file.size || file.size > MAX_SCREENSHOT) return 'Use a screenshot under 350 KB.';
  return '';
}

function readScreenshot(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ type: file.type, data: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('Couldn’t read this screenshot. Choose it again or send without it.'));
    reader.readAsDataURL(file);
  });
}

async function feedbackRequest(url, options) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    return { response, result };
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Atelier took too long to respond. Try again shortly.');
    throw err;
  } finally { clearTimeout(timeout); }
}

/** Integration: headers() returns auth headers, role() returns owner/tester/signedout, context() returns mode/version/online. */
export function createFeedback({ headers = () => ({}), role = () => 'signedout', context = () => ({}), toast = () => {} } = {}) {
  let dialog, form, message, screenshot, diagnostics, error, send, screenshotNote, removeScreenshot, sending = false;
  let inboxSerial = 0;
  const showError = (text) => { error.textContent = text; error.hidden = !text; };
  function init() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'sheet feedback-sheet';
    dialog.id = 'feedback';
    dialog.setAttribute('aria-labelledby', 'feedbackTitle');
    dialog.setAttribute('aria-describedby', 'feedbackPrivacy');
    dialog.innerHTML = `<form class="sheet-body feedback-form">
      <div class="sheet-head"><h2 id="feedbackTitle">Send feedback</h2><button class="icon-btn" type="button" data-close aria-label="Close feedback">×</button></div>
      <p class="hint feedback-lead">What worked, broke, or felt confusing? Your feedback goes directly to Cole.</p>
      <label class="field"><span>Type</span><select name="kind"><option value="bug">Bug</option><option value="confusing">Confusing</option><option value="suggestion">Suggestion</option></select></label>
      <label class="field"><span>Your feedback</span><textarea name="message" rows="5" maxlength="4000" required placeholder="What happened, and what did you expect?" autofocus></textarea><small>Up to 4,000 characters. Please leave out passwords and private account details.</small></label>
      <label class="field"><span>Screenshot <small>Optional · PNG, JPEG or WebP · under 350 KB</small></span><input name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" /><small class="feedback-file-note" aria-live="polite"></small></label>
      <button type="button" class="chip feedback-remove-shot" data-clear-shot hidden>Remove screenshot</button>
      <label class="feedback-check"><input name="diagnostics" type="checkbox" /><span>Include basic diagnostics<small>Mode, app version, online status and screen size. No prompts, threads or account details.</small></span></label>
      <p class="hint feedback-privacy" id="feedbackPrivacy">Sending shares your message, any screenshot you choose, and diagnostics only if selected. Submitted feedback is kept for up to 90 days.</p>
      <p class="hint bad feedback-error" role="alert" hidden></p>
      <div class="sheet-foot"><button class="chip" type="button" data-close>Cancel</button><button class="btn-primary" type="submit">Send feedback</button></div>
    </form>`;
    document.body.append(dialog);
    form = dialog.querySelector('form');
    message = form.elements.message;
    screenshot = form.elements.screenshot;
    diagnostics = form.elements.diagnostics;
    send = form.querySelector('[type="submit"]');
    error = form.querySelector('.feedback-error');
    screenshotNote = form.querySelector('.feedback-file-note');
    removeScreenshot = form.querySelector('[data-clear-shot]');
    removeScreenshot.addEventListener('click', () => {
      screenshot.value = '';
      screenshot.setCustomValidity('');
      screenshotNote.textContent = '';
      screenshotNote.classList.remove('bad');
      removeScreenshot.hidden = true;
      showError('');
    });
    dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
    screenshot.addEventListener('change', () => {
      const file = screenshot.files[0], problem = screenshotProblem(file);
      screenshotNote.textContent = problem || (file ? `${file.name} · ${Math.ceil(file.size / 1024)} KB. Check it for private information before sending.` : '');
      screenshotNote.classList.toggle('bad', !!problem);
      screenshot.setCustomValidity(problem);
      removeScreenshot.hidden = !file;
      showError('');
    });
    form.addEventListener('submit', submit);
  }

  async function submit(event) {
    event.preventDefault();
    if (sending) return;
    if (!['owner', 'tester'].includes(role())) { showError('Sign in to send feedback. Your message will stay here.'); return; }
    const file = screenshot.files[0], problem = screenshotProblem(file);
    if (problem) { showError(problem); return; }
    if (!message.value.trim()) { showError('Add a message before sending feedback.'); message.focus(); return; }
    const payload = { kind: form.elements.kind.value, message: message.value };
    if (diagnostics.checked) payload.diagnostics = feedbackDiagnostics(context(), { width: window.innerWidth, height: window.innerHeight });
    sending = true;
    send.disabled = true;
    send.textContent = 'Sending…';
    showError('');
    // Freeze editing until this submission finishes, including a slow screenshot read. Failure restores the form.
    for (const element of [form.elements.kind, message, screenshot, diagnostics, removeScreenshot]) element.disabled = true;
    try {
      if (file) payload.screenshot = await readScreenshot(file);
      const { response, result } = await feedbackRequest('/api/feedback', { method: 'POST', credentials: 'same-origin', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok || result.ok !== true) throw new Error(result.error || 'Couldn’t send your feedback. Your message is still here; try again.');
      form.reset();
      screenshot.setCustomValidity('');
      screenshotNote.textContent = '';
      screenshotNote.classList.remove('bad');
      removeScreenshot.hidden = true;
      dialog.close();
      toast('Thanks — your feedback was sent.');
    } catch (err) { showError(err.message || 'Couldn’t send your feedback. Your message is still here; try again.'); }
    finally {
      sending = false;
      send.disabled = false;
      send.textContent = 'Send feedback';
      for (const element of [form.elements.kind, message, screenshot, diagnostics, removeScreenshot]) element.disabled = false;
    }
  }

  function open() {
    init();
    if (!dialog.open) dialog.showModal();
    if (!sending) {
      showError(['owner', 'tester'].includes(role()) ? '' : 'Sign in to send feedback. Your message will stay here.');
      message.focus();
    }
  }

  async function showInbox(container) {
    const serial = ++inboxSerial;
    if (role() !== 'owner') { container.textContent = 'Only the owner can view submitted feedback.'; return; }
    container.innerHTML = '<p class="hint" role="status">Loading feedback…</p>';
    try {
      const { response, result } = await feedbackRequest('/api/feedback', { headers: headers(), credentials: 'same-origin' });
      if (!response.ok) throw new Error(result.error || 'Couldn’t load feedback.');
      if (serial !== inboxSerial || role() !== 'owner') return;
      const entries = Array.isArray(result.entries) ? result.entries : [];
      if (!entries.length) { container.innerHTML = '<p class="hint">No feedback yet. New submissions will appear here.</p>'; return; }
      container.innerHTML = `<div class="feedback-inbox">${entries.map((entry) => {
        const date = Number.isSafeInteger(entry.at) ? new Date(entry.at).toLocaleString() : '';
        const diag = feedbackDiagnostics(entry.diagnostics || {}, entry.diagnostics?.viewport || {});
        const detail = diag ? `<details class="feedback-diagnostics"><summary>Basic diagnostics</summary><pre>${esc(JSON.stringify(diag, null, 2))}</pre></details>` : '';
        const image = entry.screenshot && TYPES.has(entry.screenshot.type) && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(entry.id)
          ? `<details class="feedback-screenshot" data-feedback-id="${esc(entry.id)}"><summary>View chosen screenshot</summary><div class="feedback-image-slot"></div></details>` : '';
        return `<article class="feedback-item"><div class="feedback-item-head"><b>${esc(LABELS[entry.kind] || 'Feedback')}</b><span>${entry.role === 'owner' ? 'Owner' : 'Tester'}</span><time>${esc(date)}</time></div><p class="feedback-message">${esc(entry.message)}</p>${detail}${image}</article>`;
      }).join('')}</div>`;
      container.querySelectorAll('.feedback-screenshot').forEach((details) => {
        let busy = false, loaded = false;
        details.addEventListener('toggle', async () => {
          if (!details.open || busy || loaded || role() !== 'owner') return;
          const slot = details.querySelector('.feedback-image-slot');
          busy = true;
          slot.textContent = 'Loading screenshot…';
          try {
            const { response, result } = await feedbackRequest(`/api/feedback?id=${encodeURIComponent(details.dataset.feedbackId)}`, { headers: headers(), credentials: 'same-origin' });
            const screenshot = result.screenshot;
            if (!response.ok) throw new Error(result.error || 'Couldn’t load this screenshot.');
            if (!screenshot || !TYPES.has(screenshot.type) || typeof screenshot.data !== 'string' || screenshot.data.length > Math.ceil(MAX_SCREENSHOT / 3) * 4 || !/^[A-Za-z0-9+/=]+$/.test(screenshot.data)) throw new Error('This screenshot is unavailable.');
            if (role() !== 'owner' || serial !== inboxSerial) return;
            const image = document.createElement('img');
            image.alt = 'Screenshot attached to feedback';
            image.src = `data:${screenshot.type};base64,${screenshot.data}`;
            slot.replaceChildren(image);
            loaded = true;
          } catch (err) { slot.textContent = `${err.message || 'Couldn’t load this screenshot.'} Close and reopen to try again.`; }
          finally { busy = false; }
        });
      });
    } catch (err) {
      if (serial !== inboxSerial) return;
      container.innerHTML = `<p class="hint bad" role="alert">${esc(err.message || 'Couldn’t load feedback.')}</p><button type="button" class="chip">Try again</button>`;
      container.querySelector('button').addEventListener('click', () => showInbox(container));
    }
  }
  return { open, showInbox };
}
