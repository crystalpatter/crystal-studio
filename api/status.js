// GET: what's set up and what isn't, for the Settings screen (never returns secrets).
// POST: log in. DELETE: log out. (One file, because Vercel's free plan allows
// at most 12 functions per project.)
import { isLoggedIn, passwordMatches, sessionCookie, clearCookie } from '../lib/auth.js';
import { json, fail, body } from '../lib/http.js';
import { storeConfigured } from '../lib/store.js';
import { account, pageToken } from '../lib/graph.js';
import { tokenDebug } from '../lib/health.js';
import { elevenStatus, connectEleven, recheckEleven, disconnectEleven } from '../lib/eleven.js';

export async function GET(request) {
  const loggedIn = isLoggedIn(request);
  const base = { loggedIn, passwordSet: Boolean(process.env.APP_PASSWORD) };
  if (!loggedIn) return json(base);
  const status = {
    ...base,
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    claudeKeyShape: keyShape(process.env.ANTHROPIC_API_KEY),
    database: storeConfigured() || !process.env.VERCEL,
    media: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    devMedia: !process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN,
    metaApp: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    tokenSet: Boolean(await pageToken()),
    meta: null,
    metaError: null,
  };
  if (status.metaApp && !status.tokenSet) status.metaAppCheck = await checkMetaApp();
  status.eleven = await elevenStatus();
  if (status.tokenSet) {
    try {
      status.meta = await account();
      status.metaScopes = (await tokenDebug())?.scopes || null; // which permissions Facebook granted (names only)
    } catch (err) {
      status.metaError = err.userMessage || err.message;
      status.metaTokenCheck = await tokenShape(err);
      status.metaWhy = { code: err.code ?? null, subcode: err.subcode ?? null, meta: err.raw ?? null };
    }
  }
  return json(status);
}

// Length and prefix check for the Claude key; never returns the key.
function keyShape(k) {
  const t = (k || '').trim();
  if (!t) return null;
  return { length: t.length, prefixOk: t.startsWith('sk-ant-'), hasSpaces: /\s/.test(t) };
}

// Describes what's wrong with a saved Page token without revealing it.
async function tokenShape(err) {
  const t = await pageToken();
  let shape = 'ok';
  if (t === (process.env.META_APP_SECRET || '').trim()) shape = 'is-app-secret';
  else if (/\s/.test(t)) shape = 'has-spaces';
  else if (!t.startsWith('EAA')) shape = 'not-a-token';
  return { shape, length: t.length, meta: err.message || null };
}

// Asks Meta whether META_APP_ID + META_APP_SECRET belong together, and gives a
// plain-English hint if not. Never returns or logs the secret itself.
async function checkMetaApp() {
  const id = process.env.META_APP_ID.trim();
  const secret = process.env.META_APP_SECRET.trim();
  let shape = 'ok';
  if (/[•●*]/.test(secret)) shape = 'dots';
  else if (secret === id) shape = 'is-app-id';
  else if (!/^[0-9a-f]{32}$/i.test(secret)) shape = `not-32 (${secret.length} characters)`;
  try {
    const url = new URL('https://graph.facebook.com/oauth/access_token');
    url.search = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' });
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return { ok: Boolean(d.access_token), shape, meta: d.error?.message || null };
  } catch {
    return { ok: null, shape, meta: 'Could not reach Meta to check.' };
  }
}

export async function POST(request) {
  if (!process.env.APP_PASSWORD) return fail('APP_PASSWORD has not been set in Vercel yet.', 503);
  const { password } = await body(request);
  if (!passwordMatches(password)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return fail('That password is not right.', 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie() });
}

export async function DELETE() {
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

// Connect / check / remove ElevenLabs. The key only ever travels from her
// browser to here over HTTPS, is checked with ElevenLabs, and is stored encrypted.
export async function PATCH(request) {
  if (!isLoggedIn(request)) return fail('Please log in again.', 401);
  const b = await body(request);
  try {
    if (b.action === 'eleven-save') return json({ eleven: await connectEleven(b.key) });
    if (b.action === 'eleven-check') return json({ eleven: await recheckEleven() });
    if (b.action === 'eleven-remove') {
      await disconnectEleven();
      return json({ eleven: { connected: false } });
    }
    return fail('Unknown action.');
  } catch (err) {
    return fail(err.userMessage || 'Something went wrong.', err.status || 500);
  }
}
