// Publishes a saved post: Instagram first, then (if ticked) the Facebook Page.
//
// Instagram needs time to process videos, so publishing is a series of small
// steps. Each call to advance() moves a post as far as it can in ~40 seconds
// and saves where it got to; the next call (from the phone, or the scheduler
// every 10 minutes) carries on. A post can never be half-published twice
// because every step checks what is already done first.
import { graph, account, GraphError } from './graph.js';
import { getPost, savePost, lock, unlock, enqueue, dequeue, dueIds } from './store.js';

const MAX_TRIES = 3;
const RETRY_DELAY = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newPostShape({ id, media, caption, toFacebook, scheduledAt }) {
  const type = media.length > 1 ? 'carousel' : media[0].kind === 'video' ? 'reel' : 'image';
  return {
    id,
    type,
    media, // [{ url, kind: 'image'|'video', width, height }]
    caption,
    toFacebook: Boolean(toFacebook),
    scheduledAt: scheduledAt || null,
    createdAt: Date.now(),
    publishedAt: null,
    status: scheduledAt ? 'scheduled' : 'publishing',
    ig: { status: 'pending', children: [], container: null, mediaId: null, permalink: null, tries: 0, error: null },
    fb: { status: Boolean(toFacebook) ? 'pending' : 'off', photoIds: [], postId: null, tries: 0, error: null },
    log: [],
  };
}

function note(post, msg) {
  post.log.push({ at: Date.now(), msg });
  if (post.log.length > 30) post.log.shift();
}

// On Facebook there's no "link in bio", so point people at the booking page instead.
export function facebookCaption(caption) {
  const swapped = caption.replace(/\blink in (my |our |the )?bio\b/gi, 'link below');
  if (/crystalcosmetics\.com\.au/i.test(swapped)) return swapped;
  // Put the booking link just above the hashtags (or at the end).
  const m = swapped.match(/\n\s*\n((?:#[\p{L}\p{N}_]+\s*)+)$/u);
  const line = 'Book online: www.crystalcosmetics.com.au';
  return m ? `${swapped.slice(0, m.index)}\n\n${line}${swapped.slice(m.index)}` : `${swapped}\n\n${line}`;
}

async function containerStatus(id) {
  const r = await graph('GET', id, { fields: 'status_code,status' });
  return r;
}

// Waits (until the deadline) for an Instagram container to finish processing.
async function waitFinished(id, deadline) {
  for (;;) {
    const s = await containerStatus(id);
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return s.status_code;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      const e = new GraphError({ message: `Instagram couldn't process this ${s.status_code === 'EXPIRED' ? 'upload in time' : 'photo/video'}${s.status ? ` (${s.status})` : ''}. Check the format and try again.` });
      e.transient = false;
      throw e;
    }
    if (Date.now() + 4000 > deadline) return 'IN_PROGRESS';
    await sleep(3000);
  }
}

function mediaParams(m, extra = {}) {
  return m.kind === 'video' ? { media_type: extra.media_type || 'VIDEO', video_url: m.url, ...extra } : { image_url: m.url, ...extra };
}

async function stepInstagram(post, acct, deadline) {
  const ig = post.ig;
  if (!acct.igId) throw Object.assign(new Error('No Instagram Business account is linked to this Facebook Page.'), { transient: false });

  if (!ig.container) {
    if (post.type === 'carousel') {
      // 1. One container per carousel item (saved as we go, so a retry carries on).
      for (let i = ig.children.length; i < post.media.length; i++) {
        const m = post.media[i];
        const r = await graph('POST', `${acct.igId}/media`, mediaParams(m, { is_carousel_item: true }));
        ig.children.push(r.id);
      }
      note(post, `Instagram: ${ig.children.length} carousel items uploaded`);
      for (const child of ig.children) {
        if ((await waitFinished(child, deadline)) === 'IN_PROGRESS') return false;
      }
      const r = await graph('POST', `${acct.igId}/media`, { media_type: 'CAROUSEL', children: ig.children.join(','), caption: post.caption });
      ig.container = r.id;
    } else if (post.type === 'reel') {
      const r = await graph('POST', `${acct.igId}/media`, { media_type: 'REELS', video_url: post.media[0].url, caption: post.caption, share_to_feed: true });
      ig.container = r.id;
    } else {
      const r = await graph('POST', `${acct.igId}/media`, { image_url: post.media[0].url, caption: post.caption });
      ig.container = r.id;
    }
    note(post, 'Instagram: upload received, processing');
  }

  const state = await waitFinished(ig.container, deadline);
  if (state === 'IN_PROGRESS') {
    note(post, 'Instagram: still processing the video');
    return false;
  }
  if (state === 'PUBLISHED') {
    // Already went live on an earlier attempt (we just didn't hear back).
    const recent = await graph('GET', `${acct.igId}/media`, { fields: 'id,permalink,timestamp', limit: 1 });
    const latest = recent.data?.[0];
    ig.mediaId = latest?.id || null;
    ig.permalink = latest?.permalink || null;
  } else {
    const r = await graph('POST', `${acct.igId}/media_publish`, { creation_id: ig.container });
    ig.mediaId = r.id;
    try {
      const m = await graph('GET', r.id, { fields: 'permalink' });
      ig.permalink = m.permalink;
    } catch {
      /* the post is live; the link is a nice-to-have */
    }
  }
  ig.status = 'done';
  ig.error = null;
  post.publishedAt = Date.now();
  note(post, 'Instagram: posted');
  return true;
}

async function stepFacebook(post, acct) {
  const fb = post.fb;
  const message = facebookCaption(post.caption);
  const images = post.media.filter((m) => m.kind === 'image');
  const videos = post.media.filter((m) => m.kind === 'video');

  if (images.length === 1 && videos.length === 0) {
    const r = await graph('POST', `${acct.pageId}/photos`, { url: images[0].url, message });
    fb.postId = r.post_id || r.id;
  } else if (images.length > 1) {
    // Facebook multi-photo post: upload each photo hidden, then attach them all to one post.
    for (let i = fb.photoIds.length; i < images.length; i++) {
      const r = await graph('POST', `${acct.pageId}/photos`, { url: images[i].url, published: false });
      fb.photoIds.push(r.id);
    }
    const r = await graph('POST', `${acct.pageId}/feed`, {
      message,
      attached_media: fb.photoIds.map((id) => ({ media_fbid: id })),
    });
    fb.postId = r.id;
  } else if (videos.length) {
    const r = await graph('POST', `${acct.pageId}/videos`, { file_url: videos[0].url, description: message }, { video: true });
    fb.postId = r.id;
  }
  fb.status = 'done';
  fb.error = null;
  note(post, 'Facebook: posted');
}

function overall(post) {
  if (post.ig.status === 'failed') return 'failed';
  if (post.ig.status !== 'done') return 'publishing';
  if (post.fb.status === 'pending') return 'publishing';
  if (post.fb.status === 'failed') return 'partial';
  return 'published';
}

function recordError(post, which, err) {
  const part = post[which];
  part.tries += 1;
  part.error = err.userMessage || err.message;
  const permanent = err.transient === false || part.tries >= MAX_TRIES;
  if (permanent) part.status = 'failed';
  note(post, `${which === 'ig' ? 'Instagram' : 'Facebook'}: ${part.error}${permanent ? '' : ' (will retry)'}`);
  return permanent;
}

// Move one post forward. Returns the updated post.
export async function advance(id, { budgetMs = 40000 } = {}) {
  if (!(await lock(id))) return { busy: true, post: await getPost(id) };
  try {
    const post = await getPost(id);
    if (!post) return { post: null };
    if (['published', 'failed', 'partial'].includes(post.status)) {
      await dequeue(id);
      return { post };
    }
    if (post.scheduledAt && post.scheduledAt > Date.now() + 30000) return { post }; // not time yet
    post.status = 'publishing';
    const deadline = Date.now() + budgetMs;
    let retryLater = false;

    let acct;
    try {
      acct = await account();
    } catch (err) {
      recordError(post, 'ig', err);
      retryLater = post.ig.status !== 'failed';
    }

    if (acct && post.ig.status === 'pending') {
      try {
        const done = await stepInstagram(post, acct, deadline);
        if (!done) retryLater = true;
      } catch (err) {
        retryLater = !recordError(post, 'ig', err);
      }
    }
    if (acct && post.ig.status === 'done' && post.fb.status === 'pending') {
      try {
        await stepFacebook(post, acct);
      } catch (err) {
        retryLater = !recordError(post, 'fb', err);
      }
    }

    post.status = overall(post);
    await savePost(post);
    if (post.status === 'publishing') {
      // Still processing → check again soon; an error → wait a few minutes.
      const anyError = post.ig.error || post.fb.error;
      await enqueue(id, Date.now() + (retryLater && anyError ? RETRY_DELAY : 15000));
    } else {
      await dequeue(id);
    }
    return { post };
  } finally {
    await unlock(id);
  }
}

// Called by the scheduler: publish everything that's due.
export async function runDue({ totalMs = 50000 } = {}) {
  const start = Date.now();
  const ids = await dueIds(Date.now());
  const results = [];
  for (const id of ids) {
    const left = totalMs - (Date.now() - start);
    if (left < 8000) break;
    const r = await advance(id, { budgetMs: Math.min(40000, left - 5000) });
    results.push({ id, status: r.busy ? 'busy' : r.post?.status ?? 'missing' });
  }
  return results;
}
