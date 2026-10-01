// Per-tester "You" profile (addendum A3): stored in the Ledger under the tester's LinkedIn sub, never in the owner's
// `me` KV key, and deleted with the tester record. GET/PUT /api/tester/profile.

export const PROFILE_MAX_BYTES = 300 * 1024;
const TEXT_MAX = 100_000, MEMORY_MAX = 400, SOURCES_MAX = 40;
export const EMPTY_PROFILE = Object.freeze({ name: '', bio: '', samples: '', style: '', learned: '', memory: [], sources: {}, updatedAt: 0 });

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

// Keeps only the fields the app's You panel uses, each with its type and a size bound.
export function cleanProfile(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const memory = (Array.isArray(doc.memory) ? doc.memory : []).filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-MEMORY_MAX)
    .map((m) => ({ ...(typeof m.id === 'string' && m.id.length <= 40 ? { id: m.id } : {}), text: text(m.text, 500), src: text(m.src, 40), at: time(m.at) }));
  const sources = {};
  if (doc.sources && typeof doc.sources === 'object' && !Array.isArray(doc.sources)) {
    for (const [k, v] of Object.entries(doc.sources).slice(0, SOURCES_MAX)) {
      if (v && typeof v === 'object') sources[text(k, 80)] = { at: time(v.at), count: time(v.count) };
    }
  }
  return {
    name: text(doc.name, 120), bio: text(doc.bio, TEXT_MAX), samples: text(doc.samples, TEXT_MAX), style: text(doc.style, TEXT_MAX),
    learned: text(doc.learned, TEXT_MAX), memory, sources, updatedAt: time(doc.updatedAt),
  };
}

export async function getProfile(stub, sub) {
  const raw = await stub.getProfile(sub);
  let doc = null;
  try { doc = raw ? JSON.parse(raw) : null; } catch {}
  return { ...EMPTY_PROFILE, ...(cleanProfile(doc) || {}) };
}

// → 'ok' | 'bad' | 'gone' (the tester was revoked meanwhile)
export async function putProfile(stub, sub, raw) {
  let doc;
  try { doc = cleanProfile(JSON.parse(raw)); } catch { return 'bad'; }
  if (!doc) return 'bad';
  return (await stub.putProfile(sub, JSON.stringify(doc))) ? 'ok' : 'gone';
}
