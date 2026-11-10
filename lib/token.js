// Keeps the Facebook Page token in the database, encrypted, so reconnecting is
// one tap in the app (no copying tokens into Vercel). The key comes from
// META_APP_SECRET, which lives only in Vercel, so the database alone can't
// reveal the token.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { kvGet, kvSet, kvDel } from './store.js';

function key() {
  const secret = (process.env.META_APP_SECRET || process.env.APP_PASSWORD || '').trim();
  return secret ? createHash('sha256').update(`crystal-studio-token:${secret}`).digest() : null;
}

export async function saveToken(token, info = {}) {
  const k = key();
  if (!k) throw new Error('META_APP_SECRET is not set, so the token cannot be stored safely.');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(String(token), 'utf8'), c.final()]);
  await kvSet('metatoken', { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), savedAt: Date.now(), ...info });
}

export async function loadToken() {
  const k = key();
  if (!k) return null;
  const rec = await kvGet('metatoken');
  if (!rec?.data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // the app secret changed since it was saved: treat as not connected
  }
}

export async function tokenInfo() {
  const rec = await kvGet('metatoken');
  return rec ? { savedAt: rec.savedAt, page: rec.page || null, ig: rec.ig || null } : null;
}

export async function clearToken() {
  await kvDel('metatoken');
}

// Other keys Crystal pastes into the app (e.g. ElevenLabs), stored the same encrypted way.
export async function saveSecret(name, value, info = {}) {
  const k = key();
  if (!k) throw new Error('META_APP_SECRET is not set, so keys cannot be stored safely.');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  await kvSet(`secret:${name}`, { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), savedAt: Date.now(), ...info });
}
export async function loadSecret(name) {
  const k = key();
  const rec = k && (await kvGet(`secret:${name}`));
  if (!rec?.data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
export async function secretInfo(name) {
  const rec = await kvGet(`secret:${name}`);
  if (!rec) return null;
  const { iv, tag, data, ...info } = rec;
  return info;
}
export async function clearSecret(name) {
  await kvDel(`secret:${name}`);
}
