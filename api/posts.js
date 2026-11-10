// List posts for the calendar (GET) and create a new post (POST).
import { randomUUID } from 'node:crypto';
import { authed, json, fail, body, query } from '../lib/http.js';
import { listPosts, savePost, enqueue, bankAdd } from '../lib/store.js';
import { advance, newPostShape } from '../lib/publisher.js';
import { check } from '../public/js/guardrails.js';

const DAY = 86400000;

export const GET = authed(async (request) => {
  const q = query(request);
  const from = Number(q.get('from')) || Date.now() - 60 * DAY;
  const to = Number(q.get('to')) || Date.now() + 120 * DAY;
  const posts = (await listPosts(from, to)).filter((p) => p.status !== 'banked'); // banked posts live on the Autopilot tab
  return json({ posts });
});

function validMediaUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && !process.env.ALLOW_HTTP_MEDIA) return false;
    return true;
  } catch {
    return false;
  }
}

export const POST = authed(async (request) => {
  const b = await body(request);
  const media = Array.isArray(b.media) ? b.media : [];
  if (!media.length) return fail('Add a photo or video first.');
  if (media.length > 10) return fail('Instagram carousels can have up to 10 items.');
  for (const m of media) {
    if (!validMediaUrl(m.url) || !['image', 'video'].includes(m.kind)) return fail('One of the uploads did not work. Please re-add it.');
  }
  const caption = String(b.caption || '').trim();
  if (caption.length > 2200) return fail('Instagram captions can be at most 2,200 characters.');
  if ((caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) return fail('Instagram allows at most 30 hashtags.');
  const toBank = b.bank === true; // no date: Autopilot gives it the next free posting slot
  let scheduledAt = b.scheduledAt && !toBank ? Number(b.scheduledAt) : null;
  if (scheduledAt && scheduledAt < Date.now() + 60000) scheduledAt = null; // in the past → post now
  if (scheduledAt && scheduledAt > Date.now() + 75 * DAY) return fail('Please schedule within the next 75 days.');

  const post = newPostShape({
    id: randomUUID(),
    media: media.map((m) => ({ url: m.url, kind: m.kind, width: m.width || null, height: m.height || null, thumb: m.thumb || null })),
    caption,
    toFacebook: b.toFacebook !== false,
    scheduledAt,
  });
  post.warnings = check(caption);
  if (toBank) {
    post.status = 'banked';
    await savePost(post);
    await bankAdd(post.id, post.createdAt);
    return json({ post });
  }
  await savePost(post);
  await enqueue(post.id, scheduledAt || Date.now());
  if (!scheduledAt) {
    const r = await advance(post.id, { budgetMs: 30000 });
    return json({ post: r.post || post });
  }
  return json({ post });
});
