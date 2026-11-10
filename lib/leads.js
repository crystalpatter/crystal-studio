// "People to reach out to": everyone Meta will tell us engaged with a post.
//
// What Meta's API gives a business about its own posts:
//   - Instagram: who COMMENTED (their @username and the comment). It never
//     says who liked, saved or shared a post, only how many.
//   - Facebook Page: who commented and who reacted (their name), when the
//     Page token has the permissions for it.
// It never gives a phone number or email. The "contact" is the person's
// profile, so Crystal replies or messages them there.
//
// Each person is remembered for 6 months so the morning email can show who is
// new since yesterday and who still hasn't had a reply.
import { graph, account } from './graph.js';
import { kvGet, kvSet } from './store.js';
import { DAY } from './time.js';

const KEEP = 180 * DAY;
const MAX_PEOPLE = 600;
const short = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const why = (err) => (/permission|\(#10\)|\(#200\)/i.test(`${err.raw || ''} ${err.message}`) ? 'permission' : err.userMessage || err.message);

async function instagram(acct, people, now) {
  const me = (acct.igUsername || '').toLowerCase();
  const list = await graph('GET', `${acct.igId}/media`, { fields: 'id,permalink,caption,timestamp,comments_count', limit: 25 });
  const posts = (list.data || []).filter((m) => (m.comments_count || 0) > 0).slice(0, 15);
  let seen = 0;
  let named = 0;
  for (let i = 0; i < posts.length; i += 5) {
    const batch = posts.slice(i, i + 5);
    const results = await Promise.all(batch.map((m) => graph('GET', `${m.id}/comments`, { fields: 'id,text,username,timestamp,replies{username,timestamp}', limit: 50 })));
    results.forEach((r, j) => {
      const post = batch[j];
      seen += (r.data || []).length;
      named += (r.data || []).filter((c) => c.username).length;
      for (const c of r.data || []) {
        const user = (c.username || '').toLowerCase();
        if (!user || user === me) continue;
        const replied = (c.replies?.data || []).some((x) => (x.username || '').toLowerCase() === me);
        touch(people, `ig:${user}`, { platform: 'instagram', name: `@${c.username}`, url: `https://www.instagram.com/${c.username}/` }, { id: c.id, kind: 'comment', text: short(c.text), at: Date.parse(c.timestamp) || now, postUrl: post.permalink, post: short(post.caption, 60), replied }, now);
      }
    });
  }
  // Instagram reports comments on these posts but hands none over: that is what it does
  // when the app hasn't been given the instagram_manage_comments permission.
  // (Same when it hands over the comments with the writers' usernames left out.)
  if (posts.length && named === 0) throw Object.assign(new Error('(#10) permission'), { raw: 'permission' });
  return { posts: posts.length, seen, named };
}

async function facebook(acct, people, now, firstRun) {
  const notes = {};
  let posts = [];
  const base = 'id,permalink_url,message,created_time';
  for (const extra of [',comments.summary(true).limit(25){id,from,message,created_time,comments.limit(10){from}},reactions.summary(true).limit(100){id,name,type}', ',comments.summary(true).limit(25){id,from,message,created_time}', ',reactions.summary(true).limit(100){id,name,type}']) {
    try {
      posts = (await graph('GET', `${acct.pageId}/published_posts`, { fields: base + extra, limit: 10 })).data || [];
      break;
    } catch (err) {
      notes.error = why(err);
    }
  }
  let hidden = 0;
  let counted = 0;
  let named = 0;
  for (const p of posts) {
    counted += (p.comments?.summary?.total_count || 0) + (p.reactions?.summary?.total_count || 0);
    named += (p.comments?.data || []).filter((c) => c.from?.id).length + (p.reactions?.data || []).filter((r) => r.id).length;
    const postUrl = p.permalink_url || `https://www.facebook.com/${p.id}`;
    for (const c of p.comments?.data || []) {
      if (!c.from?.id) { hidden++; continue; }
      if (c.from.id === acct.pageId) continue;
      const replied = (c.comments?.data || []).some((x) => x.from?.id === acct.pageId);
      touch(people, `fb:${c.from.id}`, { platform: 'facebook', name: c.from.name || 'Someone on Facebook', url: postUrl }, { id: c.id, kind: 'comment', text: short(c.message), at: Date.parse(c.created_time) || now, postUrl, post: short(p.message, 60), replied }, now);
    }
    for (const r of p.reactions?.data || []) {
      if (!r.id || r.id === acct.pageId) continue;
      // Reactions carry no time, so "when" is when we first noticed it (0 on the very first run = not "new").
      touch(people, `fb:${r.id}`, { platform: 'facebook', name: r.name || 'Someone on Facebook', url: postUrl }, { id: `${p.id}:${r.id}`, kind: 'reaction', text: String(r.type || 'LIKE').toLowerCase(), at: firstRun ? 0 : now, postUrl, post: short(p.message, 60), replied: false }, now);
    }
  }
  if (hidden) notes.hidden = hidden;
  // Facebook counts comments/reactions on the Page's posts but names nobody: the
  // pages_read_user_content permission is missing.
  if (counted > 0 && named === 0) notes.error = 'permission';
  else if (posts.length) delete notes.error;
  return notes;
}

function touch(people, key, who, item, now) {
  const p = (people[key] ||= { ...who, firstSeen: now, items: [] });
  Object.assign(p, who, { lastSeen: now });
  const old = p.items.find((x) => x.id === item.id);
  if (old) Object.assign(old, { text: item.text, replied: item.replied || old.replied });
  else p.items.push(item);
  p.items = p.items.sort((a, b) => b.at - a.at).slice(0, 5);
}

// Reads the latest engagement, updates the saved list, and returns what the report needs.
export async function collectLeads(now = Date.now()) {
  const saved = (await kvGet('leads')) || { people: {}, runs: 0 };
  const people = saved.people;
  const status = { instagram: 'ok', facebook: 'ok' };
  let acct;
  try {
    acct = await account();
  } catch (err) {
    return { available: false, error: err.userMessage || err.message, fresh: [], waiting: [], total: Object.keys(people).length, status: { instagram: 'offline', facebook: 'offline' } };
  }
  if (acct.igId) status.instagramRead = await instagram(acct, people, now).catch((err) => ((status.instagram = why(err)), null));
  else status.instagram = 'not-linked';
  const fbNotes = await facebook(acct, people, now, saved.runs === 0).catch((err) => ({ error: why(err) }));
  if (fbNotes.error) status.facebook = fbNotes.error;
  status.facebookHidden = fbNotes.hidden || 0;

  // Forget people we haven't seen for 6 months, and keep the list a sane size.
  for (const [k, p] of Object.entries(people)) if (now - (p.lastSeen || 0) > KEEP) delete people[k];
  const keys = Object.keys(people).sort((a, b) => latest(people[b]) - latest(people[a]));
  for (const k of keys.slice(MAX_PEOPLE)) delete people[k];
  await kvSet('leads', { people, runs: saved.runs + 1, at: now });

  const all = Object.values(people).map((p) => ({ ...p, latest: p.items[0], when: latest(p), waiting: p.items.some((i) => i.kind === 'comment' && !i.replied) }));
  const fresh = all.filter((p) => p.when > now - DAY).sort((a, b) => b.when - a.when);
  const waiting = all.filter((p) => p.waiting && p.when <= now - DAY && p.when > now - 30 * DAY).sort((a, b) => b.when - a.when);
  return { available: true, fresh, waiting, total: all.length, status };
}
const latest = (p) => Math.max(0, ...p.items.map((i) => i.at));
