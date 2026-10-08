// Claude chats import, off the main thread (a module worker started by app.js from claude-import.js workerUrl()).
// Unzipping and parsing a large export takes seconds and hundreds of MB: here the page stays responsive. The file is
// read locally: beyond loading its own two modules, this worker makes no network request. Protocol (app.js claudeSource):
//   in:  { file }            → out: { type: 'total', total, skipped }  or  { type: 'error', message }
//   in:  { type: 'next' }    → out: { type: 'batch', threads, done }   (threads: toThread results, LIMITS.batch at a time)
// The page asks for each batch after saving the one before, so only one batch is ever in flight; it cancels by
// terminating the worker.
import '/vendor/fflate.js'; // a UMD build: sets self.fflate
import { readConversations, newestFirst, toThread, LIMITS } from './claude-import.js?v=81';

let list = [], at = 0;
self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.file) {
      const bytes = new Uint8Array(await m.file.arrayBuffer());
      const all = newestFirst(readConversations(bytes, self.fflate));
      list = all.list; at = 0;
      self.postMessage({ type: 'total', total: list.length, skipped: all.skipped });
    } else if (m.type === 'next') {
      const threads = [];
      for (const end = Math.min(list.length, at + LIMITS.batch); at < end; at++) { const t = toThread(list[at]); list[at] = null; if (t) threads.push(t); }
      self.postMessage({ type: 'batch', threads, done: at >= list.length, at });
    }
  } catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
};
