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
  if (status.tokenSet) {
    try {
      status.meta = await account();
    } catch (err) {
      status.metaError = err.userMessage || err.message;
    }
  }
  return json(status);
}
