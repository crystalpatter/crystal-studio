// "Nothing new to post" fallback: find past Instagram posts that did well and
// are safe to share again.
//
// A post is only re-shared if (a) it's Crystal's own post, at least 45 days
// old, (b) it hasn't been re-shared in the last 120 days, (c) its caption
// passes the brand guardrails and doesn't mention prices, dates, offers or the
// old address, and (d) Instagram will hand back the original photo/video
// (it won't for Reels that use licensed music).
import { graph, account } from './graph.js';
import { cacheGet, cacheSet, kvGet, kvSet } from './store.js';
import { check } from '../public/js/guardrails.js';
import { DAY } from './time.js';

export const MIN_AGE_DAYS = 45;
export const REST_DAYS = 120;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;

const DATED = [
  [/\$\s?\d/, 'mentions a price'],
  [/\b(today|tonight|tomorrow|this (week|weekend|month|morning|arvo|afternoon|mon|tues|wednes|thurs|fri|satur|sun)\w*|next (week|month)|right now)\b/i, 'talks about a specific time'],
  [/\b(giveaway|competition|sale|special|specials|discount|promo\w*|%\s?off|limited|last (spots?|chance)|spots? (left|available|open)|availability|fully booked|books? (are|is) (open|closed))\b/i, 'mentions an offer or availability'],
  [/\b(christmas|xmas|easter|valentine'?s?|mother'?s day|father'?s day|new year|black friday|january|february|april|june|july|august|september|october|november|december|20[12]\d)\b/i, 'mentions a date or season'],
  [/\b(shop\s*5|5b|201 varsity|we('| ha)ve moved|new (address|location|studio|home)|moving)\b/i, 'mentions an address or move'],
  [/\b(course|training|student|masterclass|model call|models? (needed|wanted))\b/i, 'is about training or a model call'],
];

// Why a caption shouldn't be re-used as it is ([] = fine).
export function reuseProblems(caption = '') {
  const out = check(caption).map((w) => w.why);
  for (const [re, why] of DATED) if (re.test(caption)) out.push(`Caption ${why}`);
  if (!caption.trim()) out.push('No caption');
  return out;
}

function mediaOf(m) {
  const one = (x) => {
    const video = x.media_type === 'VIDEO';
    return x.media_url ? { url: x.media_url, kind: video ? 'video' : 'image', thumb: video ? x.thumbnail_url || null : x.media_url } : null;
  };
  const items = m.media_type === 'CAROUSEL_ALBUM' ? (m.children?.data || []).map(one) : [one(m)];
  return items.length && items.every(Boolean) ? items : null;
}

async function insightsFor(id) {
  const cached = await cacheGet(`mi:${id}`);
  if (cached) return cached;
  let stats = {};
  for (const metric of ['reach,saved,shares,views,total_interactions', 'reach,saved,shares', 'reach']) {
    try {
      const r = await graph('GET', `${id}/insights`, { metric });
      for (const d of r.data || []) stats[d.name] = d.values?.[0]?.value ?? d.total_value?.value ?? null;
      break;
    } catch {
      stats = {};
    }
  }
  await cacheSet(`mi:${id}`, stats, 3 * 86400);
  return stats;
}

export function score(s) {
  const n = (v) => (typeof v === 'number' ? v : 0);
  const engagement = n(s.likes) + 2 * n(s.comments) + 4 * n(s.saved) + 6 * n(s.shares);
  // Old posts (before the account was a business account) have no reach figure.
  return typeof s.reach === 'number' ? s.reach + engagement : 10 * engagement;
}

async function allMedia(igId) {
  const out = [];
  let after;
  for (let page = 0; page < 3; page++) {
    const r = await graph('GET', `${igId}/media`, {
      fields: 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count,children{media_type,media_url,thumbnail_url}',
      limit: 50,
      after,
    });
    out.push(...(r.data || []));
    after = r.paging?.cursors?.after;
    if (!after || !r.paging?.next) break;
  }
  return out;
}

// Every past post, scored, with the reason it can't be re-used (if any).
// Cached for 12 hours: the ranking barely moves day to day.
export async function ranked({ fresh = false, now = Date.now() } = {}) {
  if (!fresh) {
    const c = await cacheGet('evergreen');
    if (c) return c;
  }
  const acct = await account();
  if (!acct.igId) return [];
  const media = await allMedia(acct.igId);
  const list = [];
  for (let i = 0; i < media.length; i += 8) {
    const batch = media.slice(i, i + 8);
    const stats = await Promise.all(batch.map((m) => insightsFor(m.id)));
    batch.forEach((m, j) => {
      const s = { likes: m.like_count ?? null, comments: m.comments_count ?? null, ...stats[j] };
      list.push({
        id: m.id,
        caption: m.caption || '',
        type: m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'reel' : 'image',
        timestamp: Date.parse(m.timestamp),
        permalink: m.permalink,
        thumb: m.thumbnail_url || (m.media_type === 'VIDEO' ? null : m.media_url) || m.children?.data?.[0]?.media_url || null,
        media: mediaOf(m),
        stats: s,
        score: score(s),
      });
    });
  }
  list.sort((a, b) => b.score - a.score);
  await cacheSet('evergreen', list, 12 * 3600);
  return list;
}

// { [instagram media id]: time it may be used again }. Covers re-shares and "not this one" taps.
export async function resting() {
  return (await kvGet('resting')) || {};
}
export async function rest(mediaId, days = REST_DAYS, now = Date.now()) {
  const r = await resting();
  r[mediaId] = now + days * DAY;
  for (const k of Object.keys(r)) if (r[k] < now) delete r[k];
  await kvSet('resting', r);
}

export function whyNot(item, { now = Date.now(), restMap = {}, ownReposts = new Set() } = {}) {
  if (ownReposts.has(item.id)) return 'Is itself a re-share';
  if (now - item.timestamp < MIN_AGE_DAYS * DAY) return `Posted less than ${MIN_AGE_DAYS} days ago`;
  if ((restMap[item.id] || 0) > now) return 'Re-shared (or skipped) recently';
  if (!item.media) return "Instagram won't hand back the original file (usually a Reel with licensed music)";
  const problems = reuseProblems(item.caption);
  return problems.length ? problems[0] : null;
}

// The best posts that can be re-shared right now, best first.
export async function candidates({ now = Date.now(), ownReposts = new Set(), fresh = false } = {}) {
  const [list, restMap] = await Promise.all([ranked({ fresh, now }), resting()]);
  return list.filter((item) => !whyNot(item, { now, restMap, ownReposts }));
}

// Copies a file from Instagram into our own storage, because Instagram's links
// expire within hours and the post may not go out until this evening.
export async function keepCopy(url, name, kind) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return url; // local testing: use it as it is
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Could not fetch the original file (${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  const size = Number(res.headers.get('content-length') || 0);
  if (kind === 'image' && type !== 'image/jpeg') throw new Error(`Original photo is ${type || 'an unknown format'}, not JPEG`);
  if (kind === 'video' && size > MAX_VIDEO_BYTES) throw new Error('Original video is too large to copy');
  const { put } = await import('@vercel/blob');
  const out = await put(`auto/${name}`, res.body, {
    access: 'public',
    contentType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    addRandomSuffix: true,
    multipart: size > 20 * 1024 * 1024,
  });
  return out.url;
}

export async function dropCopy(url) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !/\.blob\.vercel-storage\.com\//.test(url)) return;
  const { del } = await import('@vercel/blob');
  await del(url);
}
