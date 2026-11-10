// Website visit counts for the morning report. The website sends a tiny
// anonymous "someone visited / someone tapped Book" ping (see api/t.js). No
// cookies, no names, no IP addresses: just counters per day.
import { countAdd, countGet, countSize } from './store.js';
import { dayKey, DAY } from './time.js';

const KEEP = 400 * 86400;
const MAX_FIELDS = 600; // stops junk traffic from growing a day's record without limit

export const SOURCE_LABEL = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  'google-ads': 'Google Ads',
  google: 'Google search',
  'google-maps': 'Google Maps / Business Profile',
  bing: 'Bing',
  'paid-social': 'Paid social ads',
  email: 'Email',
  direct: 'Direct / typed in',
  other: 'Other websites',
};
export const PAID = ['google-ads', 'paid-social'];

const clean = (s, max) => String(s || '').toLowerCase().replace(/[^a-z0-9/_.-]/g, '').slice(0, max);

export async function record({ e, s, p, n }, now = Date.now()) {
  const event = ['pv', 'book', 'call', 'form', 'dm'].includes(e) ? e : null;
  if (!event) return false;
  const source = SOURCE_LABEL[clean(s, 20)] ? clean(s, 20) : 'other';
  const name = `web:${dayKey(now)}`;
  const fields = [event, `${event}|s|${source}`];
  if (event === 'pv' && n) fields.push('visit', `visit|s|${source}`);
  const path = clean(p, 80) || '/';
  if (event !== 'call' && event !== 'form' && (await countSize(name)) < MAX_FIELDS) fields.push(`${event}|p|${path}`);
  await countAdd(name, fields, KEEP);
  return true;
}

function fold(days) {
  const t = { visits: 0, pageviews: 0, book: 0, call: 0, form: 0, bySource: {}, pages: {}, bookPages: {} };
  for (const d of days) {
    for (const [k, raw] of Object.entries(d || {})) {
      const v = Number(raw) || 0;
      const [ev, kind, name] = k.split('|');
      if (!kind) {
        if (ev === 'visit') t.visits += v;
        if (ev === 'pv') t.pageviews += v;
        if (['book', 'call', 'form'].includes(ev)) t[ev] += v;
      } else if (kind === 's') {
        const s = (t.bySource[name] ||= { visits: 0, book: 0 });
        if (ev === 'visit') s.visits += v;
        if (ev === 'book') s.book += v;
      } else if (kind === 'p') {
        if (ev === 'pv') t.pages[name] = (t.pages[name] || 0) + v;
        if (ev === 'book') t.bookPages[name] = (t.bookPages[name] || 0) + v;
      }
    }
  }
  t.sources = Object.entries(t.bySource)
    .map(([key, v]) => ({ key, label: SOURCE_LABEL[key] || key, ...v }))
    .sort((a, b) => b.visits - a.visits);
  t.topPages = Object.entries(t.pages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([path, views]) => ({ path, views }));
  t.paidVisits = t.sources.filter((s) => PAID.includes(s.key)).reduce((n, s) => n + s.visits, 0);
  t.googleAdsVisits = t.bySource['google-ads']?.visits || 0;
  delete t.bySource;
  delete t.pages;
  return t;
}

async function range(fromMs, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(await countGet(`web:${dayKey(fromMs + i * DAY)}`));
  return out;
}

// Yesterday, the last 7 full days, and the 7 before that.
export async function summary(now = Date.now()) {
  const y = now - DAY;
  const [yesterday, week, prev, today] = await Promise.all([range(y, 1), range(now - 7 * DAY, 7), range(now - 14 * DAY, 7), range(now, 1)]);
  const everSeen = [...week, ...prev, ...today].some((d) => Object.keys(d || {}).length);
  return { tracking: everSeen, yesterday: fold(yesterday), week: fold(week), prevWeek: fold(prev), today: fold(today) };
}
