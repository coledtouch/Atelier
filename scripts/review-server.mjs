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
    if (url.pathname === '/api/health') return res.end(JSON.stringify({ server: { nvidia: true } }));
    if (req.headers['x-app-pass'] !== 'review-only') { res.statusCode = 401; return res.end('{"error":"Wrong passcode"}'); }
    if (url.pathname === '/api/me') return res.end('{}');
    if (url.pathname === '/api/tools') return res.end('{"services":{},"list":[]}');
    if (url.pathname === '/api/relay/status') return res.end('{"online":false}');
    if (url.pathname === '/api/chat') {
      const parts = []; for await (const p of req) parts.push(p);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const system = body.messages?.find(m => m.role === 'system')?.content || '';
      const answer = /single-file web apps/.test(system) ? '```html\n<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review counter</title></head><body style="font:18px system-ui;padding:32px;background:#f3eee3;color:#1b1a16"><h1>Review counter</h1><p>Local fixture. No provider was called.</p><button onclick="this.textContent=Number(this.textContent)+1" style="font:inherit;padding:12px 24px">0</button></body></html>\n```'
        : /Return ONLY JSON/.test(system) ? JSON.stringify({ideas:Array.from({length:6},(_,i)=>({title:`Studio idea ${i+1}`,pitch:'A local fixture card for checking the layout and actions.',first_step:'Try expanding this idea.',tags:['Review','Fixture']}))})
        : /<title>|thread title/i.test(system) ? '<title>Design review</title>' : /<facts>/.test(system) ? '<facts></facts>' : 'This is a **local test response**. No AI provider was called.\n\n## A little room to create\n\n- Clear navigation across your studio\n- A comfortable reading width\n- Work saved on this device\n\n```javascript\nconst studio = "Atelier";\n```';
      res.setHeader('Content-Type', 'text/event-stream');
      for (const word of answer.match(/.{1,24}/gs)) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
        await new Promise(r => setTimeout(r, 40));
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
