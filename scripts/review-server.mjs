// Isolated UI fixture: no credentials, external API calls, or production data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('public');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/health') return res.end(JSON.stringify({ server: { nvidia: true, ...(process.env.REVIEW_STT ? { openai: true } : {}) } }));
    if (req.headers['x-app-pass'] !== 'review-only') { res.statusCode = 401; return res.end('{"error":"Wrong passcode"}'); }
    if (url.pathname === '/api/lookup/img') {
      if (!url.searchParams.get('k')) { res.statusCode = 400; return res.end('{"error":"That isn’t a Look up image.","code":"lookup_query"}'); }
      res.setHeader('Content-Type', 'image/png'); return res.end(await readFile(resolve(root, 'icons/atelier-v2-512.png')));
    }
    if (url.pathname === '/api/lookup') {
      const raw = url.searchParams.get('q') || url.searchParams.get('title') || '', q = raw.toLowerCase();
      const lic = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' };
      const img = { src: '/api/lookup/img?k=fixture-512', width: 512, height: 512, srcset: [[512, '/api/lookup/img?k=fixture-512']], file: 'Fixture.png', page: 'https://commons.wikimedia.org/wiki/File:Fixture.png', mat: true };
      if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Select a word or a short name to look up.', code: 'lookup_query' })); }
      if (q.includes('slow')) await new Promise((r) => setTimeout(r, 1500));
      if (q.includes('fail')) { res.statusCode = 502; return res.end(JSON.stringify({ error: 'Couldn’t reach Wikipedia — try again.', code: 'lookup_unavailable' })); }
      if (q.includes('busy')) { res.statusCode = 429; res.setHeader('Retry-After', '5'); return res.end(JSON.stringify({ error: 'Wikipedia is busy — try again in a few seconds.', code: 'lookup_busy', retryAfter: 5 })); }
      if (q.includes('zzz')) return res.end(JSON.stringify({ v: 1, found: false, lang: 'en', query: raw, search: 'https://en.wikipedia.org/w/index.php?search=zzz&ns0=1', others: [{ title: 'Sleep', description: 'Fixture alternative' }] }));
      if (q === 'mercury') return res.end(JSON.stringify({ v: 1, found: true, kind: 'choices', lang: 'en', dir: 'ltr', query: raw, title: 'Mercury', url: 'https://en.wikipedia.org/wiki/Mercury', choices: [{ title: 'Mercury (planet)', description: 'Smallest planet, nearest the Sun' }, { title: 'Mercury (element)', description: 'Chemical element with symbol Hg' }, { title: 'Freddie Mercury', description: 'British singer (1946–1991)' }], license: lic }));
      const search = q.startsWith('nero') && !q.includes('(');
      const title = url.searchParams.get('title') || 'Domus Aurea';
      return res.end(JSON.stringify({ v: 1, found: true, kind: 'article', via: search ? 'search' : q.includes('(') ? 'inner' : 'title', lang: 'en', dir: 'ltr', query: raw, title, description: 'Roman palace (fixture)', extract: 'Local fixture summary. No Wikipedia call was made. A third sentence checks the three-line clamp on phones and the four-line clamp on desktop.', trimmed: true, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, image: q.includes('plain') ? null : img, others: search ? [{ title: 'Palace Tomb', description: 'Fixture alternative' }, { title: 'Nero', description: 'Roman emperor' }] : [], license: lic }));
    }
    if (url.pathname === '/api/me') return res.end('{}');
    if (url.pathname === '/api/tools') return res.end('{"services":{},"list":[]}');
    if (url.pathname === '/api/relay/status') return res.end('{"online":false}');
    if (url.pathname === '/api/transcribe' && req.method === 'POST') { // dictation stub: REVIEW_STT=ok | busy | down | format | slow | empty
      let n = 0; for await (const p of req) n += p.length;
      const mode = process.env.REVIEW_STT || 'ok';
      await new Promise(r => setTimeout(r, mode === 'slow' ? 15_000 : 700)); // slow: time to try the tap-twice cancel
      if (mode === 'busy') { res.statusCode = 429; res.setHeader('Retry-After', '30'); return res.end('{"error":"Dictation is busy right now. Try again in a moment.","code":"transcribe_busy"}'); }
      if (mode === 'down') { res.statusCode = 502; return res.end('{"error":"Dictation is unavailable right now.","code":"transcribe_unavailable"}'); }
      if (mode === 'format') { res.statusCode = 415; return res.end('{"error":"That recording isn’t in an audio format dictation can read.","code":"unsupported_audio"}'); }
      return res.end(JSON.stringify({ text: mode === 'empty' ? '' : `Local dictation fixture: ${n} bytes received. No provider was called.`, provider: 'openai' }));
    }
    if (url.pathname === '/api/chat') {
      const parts = []; for await (const p of req) parts.push(p);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const system = body.messages?.find(m => m.role === 'system')?.content || '';
      const slow = /slow stream/i.test(JSON.stringify(body.messages?.at(-1) ?? ''));
      const answer = /single-file web apps/.test(system) ? '```html\n<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review counter</title></head><body style="font:18px system-ui;padding:32px;background:#f3eee3;color:#1b1a16"><h1>Review counter</h1><p>Local fixture. No provider was called.</p><button onclick="this.textContent=Number(this.textContent)+1" style="font:inherit;padding:12px 24px">0</button></body></html>\n```'
        : /Return ONLY JSON/.test(system) ? JSON.stringify({ideas:Array.from({length:6},(_,i)=>({title:`Studio idea ${i+1}`,pitch:'A local fixture card for checking the layout and actions.',first_step:'Try expanding this idea.',tags:['Review','Fixture']}))})
        : /<title>|thread title/i.test(system) ? '<title>Design review</title>' : /<facts>/.test(system) ? '<facts></facts>' : 'This is a **local test response**. No AI provider was called.\n\nNero\'s Golden House (Domus Aurea) sat on the Oppian Hill. Mercury is both a planet and a metal.\n\nLook-up test words: slow river, fail state, busy signal, zzz nothing, plain text.\n\n## A little room to create\n\n- Clear navigation across your studio\n- A comfortable reading width\n- Work saved on this device\n\n```javascript\nconst studio = "Atelier";\n```';
      res.setHeader('Content-Type', 'text/event-stream');
      for (const word of answer.match(/.{1,24}/gs)) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
        await new Promise(r => setTimeout(r, slow ? 250 : 40));
      }
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 503; return res.end('{"error":"This integration is not available in the local review fixture."}');
  }
  try {
    const name = url.pathname === '/' ? '/index.html' : ['/privacy', '/tos'].includes(url.pathname) ? `${url.pathname}.html` : url.pathname;
    const file = resolve(root, '.' + decodeURIComponent(name));
    if (!file.startsWith(root + sep)) { res.statusCode = 403; return res.end(); }
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
}).listen(8791, '127.0.0.1', () => console.log('Isolated review: http://127.0.0.1:8791 — passcode: review-only'));
