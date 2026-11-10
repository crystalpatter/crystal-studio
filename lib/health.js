// The morning "is everything still connected?" check.
// Each check returns { key, label, ok: true | false | null, note, fix }.
// ok === null means "can't tell / optional", and never raises an alarm.
import { account, pageToken, GRAPH_VERSION } from './graph.js';
import { storeConfigured, kvGet, listPosts } from './store.js';
import { mailConfigured } from './mail.js';
import { reportRecipient } from './config.js';
import { appUrl } from './links.js';
import { DAY, HOUR, fmt } from './time.js';

export const WEBSITE = process.env.HEALTH_WEBSITE || 'https://www.crystalcosmetics.com.au/';
export const BOOKING = process.env.HEALTH_BOOKING || 'https://bookings.gettimely.com/crystalcosmetics/bb/book';

async function fetchOk(url, mustContain) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'CrystalStudio-monitor/1.0' } });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, note: `Answered with error ${res.status}` };
    if (mustContain && !(await res.text()).includes(mustContain)) return { ok: false, note: `Loaded, but the "${mustContain}" booking link is missing from the page` };
    return { ok: true, note: `Loaded in ${(ms / 1000).toFixed(1)}s` };
  } catch (err) {
    return { ok: false, note: err.name === 'TimeoutError' ? 'Did not answer within 12 seconds' : 'Could not be reached' };
  }
}

// Asks Meta about the saved connection: when it runs out and what it may do.
export async function tokenDebug() {
  const id = (process.env.META_APP_ID || '').trim();
  const secret = (process.env.META_APP_SECRET || '').trim();
  const token = await pageToken();
  if (!id || !secret || !token) return null;
  try {
    const url = new URL(`${process.env.GRAPH_BASE || 'https://graph.facebook.com'}/${GRAPH_VERSION}/debug_token`);
    url.search = new URLSearchParams({ input_token: token, access_token: `${id}|${secret}` });
    const d = (await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json()).data;
    if (!d) return null;
    return {
      valid: Boolean(d.is_valid),
      expiresAt: d.expires_at ? d.expires_at * 1000 : null,
      dataAccessExpiresAt: d.data_access_expires_at ? d.data_access_expires_at * 1000 : null,
      issuedAt: d.issued_at ? d.issued_at * 1000 : null,
      scopes: d.scopes || [],
      error: d.error ? { code: d.error.code, subcode: d.error.subcode, message: d.error.message } : null,
    };
  } catch {
    return null;
  }
}

export async function runChecks(now = Date.now()) {
  const app = appUrl();
  const out = [];
  const add = (key, label, ok, note = '', fix = null) => out.push({ key, label, ok, note, fix });

  // Instagram + Facebook
  let acct = null;
  let metaError = null;
  try {
    acct = await account();
  } catch (err) {
    metaError = err.userMessage || err.message;
  }
  const dbg = await tokenDebug();
  const reconnect = { label: 'Reconnect', url: `${app}/#settings` };
  if (acct) {
    add('instagram', acct.igUsername ? `Instagram @${acct.igUsername}` : 'Instagram', Boolean(acct.igId), acct.igId ? 'Connected' : 'The Facebook Page has no Instagram account linked', acct.igId ? null : reconnect);
    add('facebook', `Facebook Page ${acct.pageName || ''}`.trim(), true, 'Connected');
    const ends = [dbg?.expiresAt, dbg?.dataAccessExpiresAt].filter(Boolean).sort()[0];
    if (ends && ends - now < 14 * DAY) add('meta-expiry', 'Facebook login renewal', false, `Facebook will ask you to confirm access again on ${fmt(ends, { weekday: 'short', day: 'numeric', month: 'short' })}. Tap Reconnect before then so posting doesn't stop.`, reconnect);
  } else {
    add('instagram', 'Instagram', false, metaError, reconnect);
    add('facebook', 'Facebook Page', false, 'Same connection as Instagram', reconnect);
  }

  // Website + booking page
  const [site, book] = await Promise.all([fetchOk(WEBSITE, 'gettimely.com'), fetchOk(BOOKING)]);
  add('website', 'Website crystalcosmetics.com.au', site.ok, site.note);
  add('booking', 'Timely online booking page', book.ok, book.note);

  // The automation itself
  const hb = await kvGet('heartbeat').catch(() => null);
  const age = hb?.at ? now - hb.at : null;
  add('scheduler', 'Scheduler (publishes posts on time)', age !== null && age < 3 * HOUR, age === null ? 'Has not run yet' : age < 3 * HOUR ? `Last ran ${Math.max(1, Math.round(age / 60000))} min ago` : `Last ran ${Math.round(age / HOUR)} hours ago`);
  add('database', 'Post calendar database', storeConfigured() || !process.env.VERCEL, '');
  add('storage', 'Photo & video storage', process.env.BLOB_READ_WRITE_TOKEN ? true : process.env.VERCEL ? false : null, '');

  const recent = await listPosts(now - 3 * DAY, now).catch(() => []);
  const broken = recent.filter((p) => ['failed', 'partial'].includes(p.status));
  add('publishing', 'Recent posts published cleanly', broken.length === 0, broken.length ? `${broken.length} post${broken.length > 1 ? 's' : ''} in the last 3 days did not fully publish: ${broken[0].ig.error || broken[0].fb.error || ''}` : '', broken.length ? { label: 'Open Calendar', url: `${app}/#calendar` } : null);

  add('email', 'Morning email', mailConfigured() ? true : false, mailConfigured() ? '' : 'The email key (RESEND_API_KEY) has not been added in Vercel yet', null);
  add('captions', 'AI captions', process.env.ANTHROPIC_API_KEY ? true : null, process.env.ANTHROPIC_API_KEY ? '' : 'Optional: not set up');

  return { checks: out, account: acct, token: dbg };
}
