// Relay: lets Atelier on any device drive the browser extension running on the user's computer.
// The extension holds a hibernating WebSocket here; commands from the app are forwarded to it and the
// matching reply is returned. One instance ("main") — this is a single-user app.
import { DurableObject } from 'cloudflare:workers';

// Long enough for the extension's own click/type confirmation (it gives up after 45 s) plus the action itself.
const COMMAND_TIMEOUT_MS = 90_000;

// Commands that only run once the owner approved the step in the app (the {approved} flag): click and type, opening a
// page, and reading one by its address (browser_read with a url: the extension loads it, signed in as the owner, so the
// address the model chose could carry data out). Reading a tab that is already open (a tabId alone) doesn't need it; a
// url needs it even beside a tabId, as the app asks for it then (public/app.js asksFirst). The Worker's /api/relay/cmd
// checks this, the Relay below checks it again before anything reaches the browser, and the extension
// (extension/background.js) checks open and read once more.
export function relayNeedsApproval(cmd, args) {
  if (cmd === 'click' || cmd === 'type' || cmd === 'signin' || cmd === 'open') return true;
  if (cmd === 'messages') return args?.op === 'send';
  return cmd === 'read' && Boolean(args?.url);
}

// The kinds of computer a browser can be paired as (v130). A connection's kind rides in its attachment; one accepted
// before v130 has none there, and is read from the browser's own user-agent.
const DEVICES = ['mac', 'win', 'linux', 'other'];
const deviceFromAgent = (agent) => (/Macintosh|Mac OS X/i.test(agent) ? 'mac' : /Windows/i.test(agent) ? 'win' : /Linux|CrOS/i.test(agent) ? 'linux' : 'other');
const deviceOf = (ws) => { const a = ws.deserializeAttachment?.() || {}; return DEVICES.includes(a.device) ? a.device : deviceFromAgent(a.agent || ''); };

function timingSafe(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map(); // id → { resolve, timer }
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // v130: one connection for each kind of computer (a Mac, a Windows PC, ...), where there was one in all. The owner's
  // PC connected, the Mac's connection was closed as "replaced", and his texts could no longer be reached: Messages is
  // on the Mac alone. A command goes to the newest connection, and a Messages command to the newest one from a Mac.
  browser(cmd) {
    const sockets = this.ctx.getWebSockets('browser');
    if (cmd !== 'messages') return sockets[sockets.length - 1] || null; // newest connection wins
    for (let i = sockets.length - 1; i >= 0; i--) if (deviceOf(sockets[i]) === 'mac') return sockets[i];
    return null;
  }

  async fetch(req) {
    const url = new URL(req.url);

    // Pairing token lives here (strongly consistent) — not in KV, which can lag between locations.
    if (url.pathname === '/token' && req.method === 'PUT') {
      const device = DEVICES.includes(url.searchParams.get('device')) ? url.searchParams.get('device') : '';
      // A pairing that names its computer (v130) holds that computer's token alone and revokes that computer's
      // connections alone: pairing the PC no longer signs the Mac out. One that names none is the old single token.
      if (device) {
        const tokens = (await this.ctx.storage.get('tokens')) || {};
        await this.ctx.storage.put('tokens', { ...tokens, [device]: await req.text() });
        for (const old of this.ctx.getWebSockets('browser')) if (deviceOf(old) === device) { try { old.close(4001, 'repaired'); } catch {} }
        return new Response('ok');
      }
      await this.ctx.storage.put('token', await req.text());
      // A new pairing revokes any connection made with the old token.
      for (const old of this.ctx.getWebSockets('browser')) { try { old.close(4001, 'repaired'); } catch {} }
      return new Response('ok');
    }

    if (url.pathname === '/ws') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      // The token arrives only as a WebSocket subprotocol ("atelier, <token>"), so it never appears in URLs or logs.
      // A ?token= query string is ignored: it is not a way in.
      const protocols = (req.headers.get('sec-websocket-protocol') || '').split(',').map((p) => p.trim());
      const token = protocols[0] === 'atelier' ? protocols[1] || '' : '';
      const saved = await this.ctx.storage.get('token');
      const tokens = (await this.ctx.storage.get('tokens')) || {};
      const agent = req.headers.get('user-agent') || '';
      // Which computer: the one whose own token this is, or, for the old single token, what its browser says it is.
      let device = '';
      if (token) for (const d of DEVICES) if (typeof tokens[d] === 'string' && timingSafe(token, tokens[d])) device = d;
      if (!device && token && saved && timingSafe(token, saved)) device = deviceFromAgent(agent);
      if (!device) return new Response('Browser not paired — open Atelier on this computer to pair it.', { status: 401 });
      // One live browser for each kind of computer: close that computer's older connections.
      for (const old of this.ctx.getWebSockets('browser')) if (deviceOf(old) === device) { try { old.close(4000, 'replaced'); } catch {} }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['browser']);
      server.serializeAttachment({ since: Date.now(), agent, device });
      return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'atelier' } });
    }

    if (url.pathname === '/status') {
      const ws = this.browser();
      const info = ws?.deserializeAttachment() || {};
      return Response.json({ online: Boolean(ws), since: info.since || null, mac: Boolean(this.browser('messages')) });
    }

    if (url.pathname === '/cmd' && req.method === 'POST') {
      const { cmd, args, approved } = await req.json();
      // Defence in depth behind the Worker's own check: nothing that needs the owner's OK reaches the browser without it.
      // Checked first (v130), before any connection is looked for: an unapproved step is refused whichever computer is on.
      if (relayNeedsApproval(cmd, args) && approved !== true) return Response.json({ ok: false, error: 'This action needs your approval in the app.' }, { status: 403 });
      const ws = this.browser(cmd);
      if (!ws && cmd === 'messages' && this.browser()) return Response.json({ ok: false, error: 'Your Mac isn’t connected, and texts go through it. Open Atelier in Chrome on the Mac, then try again.' }, { status: 503 });
      if (!ws) return Response.json({ ok: false, error: 'Your computer’s browser isn’t connected — make sure the computer is on and Chrome is open.' }, { status: 503 });
      const id = crypto.randomUUID();
      const reply = new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'Your computer didn’t respond in time.' }); }, COMMAND_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
      });
      try {
        ws.send(JSON.stringify({ id, cmd, args, approved: approved === true })); // the extension checks it again
      } catch {
        const p = this.pending.get(id);
        if (p) { clearTimeout(p.timer); this.pending.delete(id); }
        return Response.json({ ok: false, error: 'Lost the connection to your computer.' }, { status: 503 });
      }
      return Response.json(await reply);
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch { return; }
    const p = msg?.id && this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error || 'Browser command failed' });
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
  }
}
