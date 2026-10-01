// Relay: lets Atelier on any device drive the browser extension running on the user's computer.
// The extension holds a hibernating WebSocket here; commands from the app are forwarded to it and the
// matching reply is returned. One instance ("main") — this is a single-user app.
import { DurableObject } from 'cloudflare:workers';

// Long enough for the extension's own click/type confirmation (it gives up after 45 s) plus the action itself.
const COMMAND_TIMEOUT_MS = 90_000;

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

  browser() {
    const sockets = this.ctx.getWebSockets('browser');
    return sockets[sockets.length - 1] || null; // newest connection wins
  }

  async fetch(req) {
    const url = new URL(req.url);

    // Pairing token lives here (strongly consistent) — not in KV, which can lag between locations.
    if (url.pathname === '/token' && req.method === 'PUT') {
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
      if (!token || !saved || !timingSafe(token, saved)) return new Response('Browser not paired — open Atelier on this computer to pair it.', { status: 401 });
      // One live browser at a time: close older connections.
      for (const old of this.ctx.getWebSockets('browser')) { try { old.close(4000, 'replaced'); } catch {} }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['browser']);
      server.serializeAttachment({ since: Date.now(), agent: req.headers.get('user-agent') || '' });
      return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'atelier' } });
    }

    if (url.pathname === '/status') {
      const ws = this.browser();
      const info = ws?.deserializeAttachment() || {};
      return Response.json({ online: Boolean(ws), since: info.since || null });
    }

    if (url.pathname === '/cmd' && req.method === 'POST') {
      const ws = this.browser();
      if (!ws) return Response.json({ ok: false, error: 'Your computer’s browser isn’t connected — make sure the computer is on and Chrome is open.' }, { status: 503 });
      const { cmd, args } = await req.json();
      const id = crypto.randomUUID();
      const reply = new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'Your computer didn’t respond in time.' }); }, COMMAND_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
      });
      try {
        ws.send(JSON.stringify({ id, cmd, args }));
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
