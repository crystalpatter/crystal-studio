// ElevenLabs connection (voiceovers, music, sound effects for posts).
// Crystal pastes her API key into Settings; it's checked with ElevenLabs and
// stored encrypted (lib/token.js). Nothing is generated yet: this is the
// connection the creation features will use.
import { saveSecret, loadSecret, secretInfo, clearSecret } from './token.js';

const BASE = process.env.ELEVEN_BASE || 'https://api.elevenlabs.io';
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status, userMessage: msg });

async function ask(key, path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(12000) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, reason: data?.detail?.status || data?.detail?.code || null };
}

// Checks a key with ElevenLabs. Returns what plan it's on where the key is allowed to say.
export async function checkKey(key) {
  let r;
  try {
    r = await ask(key, '/v1/user/subscription');
  } catch {
    throw fail('Could not reach ElevenLabs to check the key. Try again in a minute.', 502);
  }
  if (r.ok) return { plan: r.data.tier || null, used: r.data.character_count ?? null, limit: r.data.character_limit ?? null, limited: false };
  // A key created with only some permissions ticked is still a real key.
  if (/missing_permissions/i.test(String(r.reason))) return { plan: null, used: null, limit: null, limited: true };
  if (r.status === 401) throw fail("ElevenLabs didn't accept that key. Copy it again from ElevenLabs → Developers → API Keys (it starts with sk_).");
  throw fail(`ElevenLabs answered with an error (${r.status}). Try again in a minute.`, 502);
}

export async function connectEleven(key) {
  const k = String(key || '').trim();
  if (k.length < 20 || /\s/.test(k)) throw fail("That doesn't look like an ElevenLabs API key.");
  const info = await checkKey(k);
  await saveSecret('eleven', k, { ...info, checkedAt: Date.now() });
  return elevenStatus();
}

export async function recheckEleven() {
  const k = await loadSecret('eleven');
  if (!k) throw fail('ElevenLabs is not connected.');
  const info = await checkKey(k);
  await saveSecret('eleven', k, { ...info, checkedAt: Date.now() });
  return elevenStatus();
}

export async function elevenStatus() {
  const info = await secretInfo('eleven').catch(() => null);
  return info ? { connected: true, plan: info.plan, used: info.used, limit: info.limit, limited: Boolean(info.limited), checkedAt: info.checkedAt } : { connected: false };
}

export const disconnectEleven = () => clearSecret('eleven');
export const elevenKey = () => loadSecret('eleven');
