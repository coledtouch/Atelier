// Usage taps for tester settlement (spec §7 "Actual (settle)"). A tap passes the upstream bytes through untouched and
// reports the provider's usage once the stream ends. Anthropic usage is collected in anthropic.js (final.usage per round).

// SSE parser that remembers the last non-empty `field` object it sees in a `data:` line (OpenAI-style `usage`, Gemini
// `usageMetadata`). result() → that object or null.
export function sseUsage(pick, field) {
  const dec = new TextDecoder();
  let buf = '', last = null;
  const line = (raw) => {
    const l = raw.trim();
    if (!l.startsWith('data:')) return;
    const d = l.slice(5).trim();
    if (!d || d === '[DONE]' || !d.includes(`"${field}"`)) return;
    try {
      let j = JSON.parse(d);
      if (Array.isArray(j)) j = j[0];
      const u = pick(j);
      if (u && typeof u === 'object' && !Array.isArray(u)) last = u;
    } catch {}
  };
  return {
    push(bytes) {
      buf += dec.decode(bytes, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 1 << 20) buf = ''; // a runaway line can't hold usage worth reading; the full reservation stands
    },
    result() {
      buf += dec.decode();
      if (buf) line(buf);
      buf = '';
      return last;
    },
  };
}
export const openaiUsage = () => sseUsage((j) => j?.usage, 'usage');
export const geminiUsage = () => sseUsage((j) => j?.usageMetadata, 'usageMetadata');

// Wraps a byte stream: every chunk is passed on as the same object, the parser sees it too, and onEnd runs exactly once
// — with parser.result() after a complete stream (before the consumer sees it close), or with null when the stream
// failed or the reader cancelled it (the full reservation stands).
export function meter(src, parser, onEnd) {
  const reader = src.getReader();
  let ended = false;
  const finish = (ok) => {
    if (ended) return undefined;
    ended = true;
    let usage = null;
    if (ok) {
      try { usage = parser.result(); } catch {}
    }
    return Promise.resolve().then(() => onEnd(usage)).catch(() => {});
  };
  return new ReadableStream({
    async pull(ctrl) {
      let r;
      try {
        r = await reader.read();
      } catch (err) {
        await finish(false);
        ctrl.error(err);
        return;
      }
      if (r.done) {
        await finish(true);
        ctrl.close();
        return;
      }
      try { parser.push(r.value); } catch {}
      ctrl.enqueue(r.value);
    },
    cancel(reason) {
      finish(false);
      return reader.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
}
