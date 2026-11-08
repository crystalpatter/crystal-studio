// What's set up and what isn't, for the Settings screen. Never returns secrets.
import { isLoggedIn } from '../lib/auth.js';
import { json } from '../lib/http.js';
import { storeConfigured } from '../lib/store.js';
import { account, pageToken } from '../lib/graph.js';

export async function GET(request) {
  const loggedIn = isLoggedIn(request);
  const base = { loggedIn, passwordSet: Boolean(process.env.APP_PASSWORD) };
  if (!loggedIn) return json(base);
  const status = {
    ...base,
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    database: storeConfigured() || !process.env.VERCEL,
    media: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    devMedia: !process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN,
    metaApp: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    tokenSet: Boolean(pageToken()),
    meta: null,
    metaError: null,
  };
  if (status.metaApp && !status.tokenSet) status.metaAppCheck = await checkMetaApp();
  if (status.tokenSet) {
    try {
      status.meta = await account();
    } catch (err) {
      status.metaError = err.userMessage || err.message;
    }
  }
  return json(status);
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
