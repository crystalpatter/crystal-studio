// Autopilot: keeps posts going out on Crystal's posting days without her
// having to pick times.
//
//  1. She adds posts to the "content bank" whenever she has time (no date).
//  2. On each posting day, if nothing is already booked for that day, the
//     oldest banked post is given that day's slot.
//  3. If the bank is empty, a past top performer is re-shared instead
//     (see evergreen.js). In "ask first" mode it waits for her tap on Approve.
//
// Everything it does is an ordinary scheduled post on the Calendar, so she can
// still change the time, post it now or cancel it.
import { randomUUID } from 'node:crypto';
import { getConfig } from './config.js';
import { listPosts, getPost, savePost, deletePost, enqueue, dequeue, bankAdd, bankRemove, bankList, kvGet, kvSet, kvOnce, kvDel, lock, unlock } from './store.js';
import { newPostShape } from './publisher.js';
import { candidates, keepCopy, dropCopy, rest, REST_DAYS } from './evergreen.js';
import { parts, at, dayKey, dayStart, DAY, HOUR } from './time.js';
import { check } from '../public/js/guardrails.js';

const LATE_OK = 3 * HOUR; // a slot can still be filled up to 3 hours late

export function slotOn(cfg, ms) {
  const p = parts(ms);
  return cfg.days.includes(p.dow) ? at(p.y, p.mo, p.d, cfg.hour, cfg.minute) : null;
}

// The next posting slot that can still be filled.
export function nextSlot(cfg, now = Date.now()) {
  if (!cfg.days.length) return null;
  for (let i = 0; i < 8; i++) {
    const s = slotOn(cfg, dayStart(now) + i * DAY + 12 * HOUR);
    if (s && now <= s + LATE_OK) return s;
  }
  return null;
}

async function postsOnDay(ms) {
  const from = dayStart(ms);
  return (await listPosts(from, from + DAY - 1)).filter((p) => p.status !== 'banked');
}

async function ownRepostIds() {
  const posts = await listPosts(Date.now() - 400 * DAY, Date.now() + DAY);
  return new Set(posts.filter((p) => p.auto && p.ig?.mediaId).map((p) => p.ig.mediaId));
}

// What would fill a slot right now, without changing anything (for the app and the email).
export async function preview(now = Date.now()) {
  const cfg = await getConfig();
  const slot = nextSlot(cfg, now);
  const bank = await bankList();
  const out = { on: cfg.autopilot, slot, bank: bank.length, fill: null };
  if (!slot) return out;
  const booked = (await postsOnDay(slot)).filter((p) => p.status !== 'failed');
  if (booked.length) out.fill = { kind: 'booked', post: brief(booked[0]) };
  else if (await kvGet(`skip:${dayKey(slot)}`)) out.fill = { kind: 'skipped' };
  else if (!cfg.autopilot) out.fill = { kind: 'off' };
  else if (bank.length) out.fill = { kind: 'bank', post: brief(bank[0]) };
  else if (!cfg.fallback) out.fill = { kind: 'empty' };
  else {
    try {
      const c = (await candidates({ now, ownReposts: await ownRepostIds() }))[0];
      out.fill = c ? { kind: 'repost', candidate: { id: c.id, caption: c.caption.slice(0, 200), thumb: c.thumb, permalink: c.permalink, stats: c.stats, type: c.type, timestamp: c.timestamp } } : { kind: 'nothing' };
    } catch (err) {
      out.fill = { kind: 'error', error: err.userMessage || err.message };
    }
  }
  return out;
}

export function brief(p) {
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    caption: p.caption.slice(0, 200),
    thumb: p.media.find((m) => m.thumb)?.thumb || null,
    scheduledAt: p.scheduledAt,
    publishedAt: p.publishedAt,
    auto: Boolean(p.auto),
    fromBank: Boolean(p.fromBank),
    hold: Boolean(p.hold),
    permalink: p.ig?.permalink || null,
    source: p.source || null,
    error: p.ig?.error || p.fb?.error || null,
    warnings: p.warnings || [],
  };
}

async function makeRepost(c, cfg, when, now) {
  const stamp = Date.now();
  const media = [];
  for (const [i, m] of c.media.entries()) {
    const url = await keepCopy(m.url, `${stamp}-${i}.${m.kind === 'video' ? 'mp4' : 'jpg'}`, m.kind);
    let thumb = m.kind === 'image' ? url : null;
    if (m.kind === 'video' && m.thumb) thumb = await keepCopy(m.thumb, `${stamp}-${i}-thumb.jpg`, 'thumb').catch(() => null);
    media.push({ url, kind: m.kind, width: null, height: null, thumb });
  }
  const post = newPostShape({ id: randomUUID(), media, caption: c.caption, toFacebook: cfg.toFacebook, scheduledAt: when });
  Object.assign(post, {
    auto: true,
    hold: cfg.approval === 'ask',
    source: { mediaId: c.id, permalink: c.permalink, postedAt: c.timestamp, stats: c.stats },
    warnings: check(c.caption),
  });
  post.log.push({ at: Date.now(), msg: `Autopilot: re-sharing a top post from ${new Date(c.timestamp).toISOString().slice(0, 10)}${post.hold ? ' (waiting for approval)' : ''}` });
  await savePost(post);
  await enqueue(post.id, when);
  await rest(c.id, REST_DAYS, now);
  return post;
}

// Fill the next slot if it's today and empty. Safe to call as often as you like.
export async function plan(now = Date.now()) {
  const cfg = await getConfig();
  await tidy(now).catch((err) => console.error('tidy', err));
  if (!cfg.autopilot) return { did: 'off' };
  const slot = slotOn(cfg, now);
  if (!slot || now > slot + LATE_OK) return { did: 'no-slot-today' };
  const key = `plan-${dayKey(slot)}`;
  if (!(await lock(key, 120))) return { did: 'busy' };
  try {
    if ((await postsOnDay(slot)).length) return { did: 'already-booked' };
    if (await kvGet(`skip:${dayKey(slot)}`)) return { did: 'skipped-today' };
    const when = Math.max(slot, now + 2 * 60000);

    const bank = await bankList();
    if (bank.length) {
      const post = bank[0];
      Object.assign(post, { status: 'scheduled', scheduledAt: when, fromBank: true });
      post.log.push({ at: Date.now(), msg: 'Autopilot: given the next posting slot from the content bank' });
      await bankRemove(post.id);
      await savePost(post);
      await enqueue(post.id, when);
      return { did: 'bank', post: brief(post) };
    }
    if (!cfg.fallback) return { did: 'empty' };

    const list = await candidates({ now, ownReposts: await ownRepostIds() });
    const errors = [];
    for (const c of list.slice(0, 4)) {
      try {
        return { did: 'repost', post: brief(await makeRepost(c, cfg, when, now)) };
      } catch (err) {
        errors.push(err.message);
        await rest(c.id, 14, now); // couldn't fetch it: leave it alone for a fortnight
      }
    }
    return { did: 'nothing', errors };
  } finally {
    await unlock(key);
  }
}

// Housekeeping, once a day: drop re-shares that were never approved, and
// delete our storage copy of re-shared videos once they've been live for 2 days.
async function tidy(now) {
  if (!(await kvOnce(`tidy:${dayKey(now)}`, 1, 2 * 86400))) return;
  const posts = await listPosts(now - 10 * DAY, now + DAY);
  for (const p of posts) {
    if (p.auto && p.hold && p.status === 'scheduled' && p.scheduledAt < now - LATE_OK) {
      await dequeue(p.id);
      await deletePost(p.id);
      if (p.source?.mediaId) await rest(p.source.mediaId, 0, now);
    } else if (p.auto && !p.cleaned && ['published', 'partial'].includes(p.status) && p.publishedAt < now - 2 * DAY) {
      for (const m of p.media) if (m.kind === 'video') await dropCopy(m.url).catch(() => {});
      p.cleaned = true;
      await savePost(p);
    }
  }
}

// ---- Things Crystal can do to an upcoming autopilot post (from the app or an email link) ----
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status, userMessage: msg });

async function upcoming(id) {
  const post = await getPost(id);
  if (!post) throw fail('That post is no longer on the calendar (it may already have been changed).', 404);
  if (post.status !== 'scheduled') throw fail(post.status === 'published' ? 'That post has already gone out.' : 'That post is no longer waiting to go out.');
  return post;
}

export async function approve(id) {
  const post = await upcoming(id);
  post.hold = false;
  post.log.push({ at: Date.now(), msg: 'Approved by Crystal' });
  await savePost(post);
  await enqueue(post.id, Math.max(post.scheduledAt, Date.now()));
  return { did: 'approved', post: brief(post) };
}

// Don't post today. A banked post goes back in the bank; a re-share is dropped.
export async function skip(id) {
  const post = await upcoming(id);
  await dequeue(post.id);
  await kvSet(`skip:${dayKey(post.scheduledAt)}`, 1, 3 * 86400);
  if (post.auto) {
    for (const m of post.media) await dropCopy(m.url).catch(() => {});
    await deletePost(post.id);
    if (post.source?.mediaId) await rest(post.source.mediaId, 0); // free to be picked another day
  } else {
    Object.assign(post, { status: 'banked', scheduledAt: null });
    await savePost(post);
    await bankAdd(post.id, post.createdAt);
  }
  return { did: 'skipped' };
}

// "Not this one": drop the re-share, rest that post for 2 months, pick the next best.
export async function swap(id) {
  const post = await upcoming(id);
  if (!post.auto) throw fail('Only automatic re-shares can be swapped.');
  await dequeue(post.id);
  for (const m of post.media) await dropCopy(m.url).catch(() => {});
  await deletePost(post.id);
  if (post.source?.mediaId) await rest(post.source.mediaId, 60);
  await kvDel(`skip:${dayKey(post.scheduledAt)}`);
  const r = await plan(Date.now());
  return { did: 'swapped', next: r.post || null, note: r.post ? null : 'Nothing else suitable was found, so nothing will go out in that slot.' };
}

// Take a post out of the bank and into the Calendar by hand, or back again.
export async function unbank(id) {
  const post = await getPost(id);
  if (!post || post.status !== 'banked') throw fail('That post is not in the bank.', 404);
  await bankRemove(id);
  await deletePost(id);
  return { did: 'removed' };
}
