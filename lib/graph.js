// Talking to Meta (Instagram Graph API + Facebook Pages API).
// The Page token is saved (encrypted) in the database when Crystal taps
// "Connect" in Settings. An older META_PAGE_TOKEN in Vercel still works as a
// fallback.
import { loadToken } from './token.js';

export const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v26.0';
const BASE = process.env.GRAPH_BASE || 'https://graph.facebook.com';
const VIDEO_BASE = process.env.GRAPH_VIDEO_BASE || process.env.GRAPH_BASE || 'https://graph-video.facebook.com';

export class GraphError extends Error {
  constructor(info = {}, status) {
    super(friendly(info));
    this.userMessage = this.message;
    this.code = info.code;
    this.subcode = info.error_subcode;
    this.raw = info.message || null; // Meta's own wording, for diagnosis (never contains the token)
    this.status = status;
    // Meta marks some errors as temporary; rate limits and server errors also are.
    this.transient = Boolean(info.is_transient) || [1, 2, 4, 17, 32, 341, 613].includes(info.code) || status >= 500;
  }
}

// Why Meta says a connection ended (error 190 sub-codes).
const WHY_190 = {
  458: 'the app was removed from the Facebook account',
  460: 'the Facebook password was changed, or Facebook reset the login for security',
  463: 'the login ran out',
  464: 'Facebook wants the account confirmed: log in to facebook.com and follow its prompts first',
  467: 'the Facebook login was signed out',
};

function friendly(e) {
  // Facebook withdrew the app's permission for this Page (e.g. the Page was unticked on a later connect).
  if (/permission\(s\) must be granted before impersonating/i.test(String(e.message).replace(/\s+/g, ' ')))
    return 'Facebook says this app no longer has permission for the Crystal Cosmetics Page. Open Settings → Reconnect Instagram & Facebook and, on Facebook\'s screen, keep the Page, @bycrystalcosmetics and every permission ticked.';
  if (e.code === 190) return `The Facebook/Instagram connection has expired${WHY_190[e.error_subcode] ? ` (${WHY_190[e.error_subcode]})` : ''}. Open Settings → Reconnect Instagram & Facebook.`;
  if (e.code === 10 || (e.code >= 200 && e.code < 300)) return `Meta says a permission is missing (${e.message}). Open Settings → Reconnect and tick every box.`;
  if ([4, 17, 32, 613].includes(e.code)) return 'Meta is limiting requests right now. The app will try again in a few minutes.';
  return e.error_user_msg || e.error_user_title || e.message || 'Meta returned an error.';
}

let saved = null; // { value, at }: the database copy, re-read at most once a minute
export async function pageToken() {
  if (!saved || Date.now() - saved.at > 60000) {
    let value = '';
    try {
      value = (await loadToken()) || '';
    } catch {
      /* database unreachable: fall back to the Vercel setting */
    }
    saved = { value, at: Date.now() };
  }
  return saved.value || (process.env.META_PAGE_TOKEN || '').trim();
}
export function forgetToken() {
  saved = null;
  accountCache = null;
}

export async function graph(method, path, params = {}, { token, video = false } = {}) {
  token = token ?? (await pageToken());
  if (!token) {
    const e = new Error('Instagram is not connected yet. Open Settings → Connect Instagram & Facebook.');
    e.userMessage = e.message;
    throw e;
  }
  const url = new URL(`${video ? VIDEO_BASE : BASE}/${GRAPH_VERSION}/${String(path).replace(/^\//, '')}`);
  const form = new URLSearchParams();
  const target = method === 'GET' ? url.searchParams : form;
  for (const [k, v] of Object.entries({ ...params, access_token: token })) {
    if (v === undefined || v === null) continue;
    target.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  let res;
  try {
    res = await fetch(url, { method, body: method === 'GET' ? undefined : form, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    const e = new GraphError({ message: `Could not reach Meta (${err.name}).`, is_transient: true }, 599);
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new GraphError(data.error || { message: `Meta returned HTTP ${res.status}` }, res.status);
  return data;
}

// Works out which Facebook Page and Instagram account the token belongs to.
let accountCache = null;
export async function account() {
  const token = await pageToken();
  if (accountCache && accountCache.token === token) return accountCache.value;
  const me = await graph('GET', 'me', { fields: 'id,name,followers_count,fan_count,instagram_business_account{id,username,followers_count,profile_picture_url}' });
  const value = {
    pageId: me.id,
    pageName: me.name,
    pageFollowers: me.followers_count ?? me.fan_count ?? null,
    igId: me.instagram_business_account?.id || null,
    igUsername: me.instagram_business_account?.username || null,
    followers: me.instagram_business_account?.followers_count ?? null,
    picture: me.instagram_business_account?.profile_picture_url || null,
  };
  accountCache = { token, value };
  return value;
}
