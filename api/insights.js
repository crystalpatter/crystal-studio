// The small insights screen: last 28 days on Instagram, plus recent posts.
// Each number is fetched on its own, so if Meta retires one metric the rest
// still show. Cached for an hour to stay well inside Meta's rate limits.
import { authed, json, query } from '../lib/http.js';
import { graph, account } from '../lib/graph.js';
import { cacheGet, cacheSet } from '../lib/store.js';

const ACCOUNT_METRICS = [
  ['reach', 'Accounts reached'],
  ['views', 'Views'],
  ['profile_views', 'Profile visits'],
  ['profile_links_taps', 'Link & button taps'],
  ['accounts_engaged', 'Accounts engaged'],
  ['total_interactions', 'Likes, saves, shares & comments'],
];
const MEDIA_METRICS = ['reach', 'saved', 'shares', 'views'];

async function accountTotals(igId) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - 28 * 86400;
  const out = [];
  await Promise.all(
    ACCOUNT_METRICS.map(async ([metric, label]) => {
      try {
        const r = await graph('GET', `${igId}/insights`, { metric, period: 'day', metric_type: 'total_value', since, until });
        const value = r.data?.[0]?.total_value?.value;
        if (typeof value === 'number') out.push({ metric, label, value });
      } catch {
        /* metric not available for this account/version: skip it */
      }
    })
  );
  return ACCOUNT_METRICS.map(([m]) => out.find((o) => o.metric === m)).filter(Boolean);
}

async function recentMedia(igId) {
  const r = await graph('GET', `${igId}/media`, {
    fields: 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count',
    limit: 12,
  });
  return Promise.all(
    (r.data || []).map(async (m) => {
      const stats = { likes: m.like_count ?? null, comments: m.comments_count ?? null };
      await Promise.all(
        MEDIA_METRICS.map(async (metric) => {
          try {
            const i = await graph('GET', `${m.id}/insights`, { metric });
            stats[metric] = i.data?.[0]?.values?.[0]?.value ?? i.data?.[0]?.total_value?.value ?? null;
          } catch {
            stats[metric] = null;
          }
        })
      );
      return {
        id: m.id,
        caption: (m.caption || '').slice(0, 140),
        type: m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : m.media_type === 'VIDEO' ? 'Video' : 'Photo',
        timestamp: m.timestamp,
        permalink: m.permalink,
        thumb: m.thumbnail_url || (m.media_type === 'VIDEO' ? null : m.media_url) || null,
        stats,
      };
    })
  );
}

export const GET = authed(async (request) => {
  const fresh = query(request).get('fresh') === '1';
  if (!fresh) {
    const cached = await cacheGet('insights');
    if (cached) return json({ ...cached, cached: true });
  }
  const acct = await account();
  if (!acct.igId) return json({ error: 'No Instagram Business account is linked to the Facebook Page.' }, 400);
  const [totals, media] = await Promise.all([accountTotals(acct.igId), recentMedia(acct.igId)]);
  const data = { username: acct.igUsername, followers: acct.followers, totals, media, fetchedAt: Date.now() };
  await cacheSet('insights', data, 3600);
  return json(data);
});
