// One post: view (GET), edit or retry (PATCH), keep publishing (POST), remove (DELETE).
import { authed, json, fail, body, query } from '../lib/http.js';
import { getPost, savePost, deletePost, enqueue, dequeue } from '../lib/store.js';
import { advance } from '../lib/publisher.js';
import { check } from '../public/js/guardrails.js';

const DAY = 86400000;

async function load(request) {
  const id = query(request).get('id');
  const post = id && (await getPost(id));
  if (!post) {
    const e = new Error('That post could not be found.');
    e.status = 404;
    e.userMessage = e.message;
    throw e;
  }
  return post;
}

export const GET = authed(async (request) => json({ post: await load(request) }));

export const POST = authed(async (request) => {
  const post = await load(request);
  const r = await advance(post.id, { budgetMs: 25000 });
  return json({ post: r.post, busy: Boolean(r.busy) });
});

export const PATCH = authed(async (request) => {
  const post = await load(request);
  const b = await body(request);

  if (b.action === 'retry') {
    if (!['failed', 'partial'].includes(post.status)) return fail('Only failed posts can be retried.');
    for (const part of [post.ig, post.fb]) {
      if (part.status === 'failed') Object.assign(part, { status: 'pending', tries: 0, error: null });
    }
    if (post.ig.status === 'pending') Object.assign(post.ig, { children: [], container: null });
    post.status = 'publishing';
    post.scheduledAt = null;
    await savePost(post);
    await enqueue(post.id, Date.now());
    const r = await advance(post.id, { budgetMs: 25000 });
    return json({ post: r.post });
  }

  if (b.action === 'now') {
    if (post.status !== 'scheduled') return fail('This post has already gone out.');
    post.hold = false;
    post.scheduledAt = null;
    post.status = 'publishing';
    await savePost(post);
    await enqueue(post.id, Date.now());
    const r = await advance(post.id, { budgetMs: 25000 });
    return json({ post: r.post });
  }

  if (post.status !== 'scheduled') return fail('Only scheduled posts can be edited. This one has already gone out.');
  if (typeof b.caption === 'string') {
    post.caption = b.caption.trim().slice(0, 2200);
    post.warnings = check(post.caption);
  }
  if (typeof b.toFacebook === 'boolean') {
    post.toFacebook = b.toFacebook;
    post.fb.status = b.toFacebook ? 'pending' : 'off';
  }
  if (b.scheduledAt) {
    const t = Number(b.scheduledAt);
    if (t < Date.now() + 60000 || t > Date.now() + 75 * DAY) return fail('Pick a time between now and 75 days ahead.');
    post.scheduledAt = t;
    await enqueue(post.id, t);
  }
  await savePost(post);
  return json({ post });
});

export const DELETE = authed(async (request) => {
  const post = await load(request);
  if (post.status === 'publishing') return fail('This post is being published right now. Try again in a minute.');
  await dequeue(post.id);
  await deletePost(post.id);
  return json({ ok: true, wasLive: Boolean(post.ig.mediaId) });
});
