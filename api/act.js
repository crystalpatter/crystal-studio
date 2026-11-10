// One-tap links from the morning email: Approve / Skip / Pick another.
// Opening the link (GET) only shows a confirm page; the button (POST) does it.
// That way email scanners that open links can't approve or cancel anything.
import { readActionToken } from '../lib/links.js';
import { approve, skip, swap } from '../lib/autopilot.js';
import { getPost } from '../lib/store.js';
import { fmt } from '../lib/time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const WORDS = {
  approve: { ask: 'Approve this post?', yes: 'Yes, post it', done: 'Approved ✓', after: 'It will go out at its scheduled time.' },
  skip: { ask: "Don't post this today?", yes: "Yes, skip today", done: 'Skipped ✓', after: 'Nothing will go out in that slot.' },
  swap: { ask: 'Pick a different post instead?', yes: 'Yes, pick another', done: 'Swapped ✓', after: '' },
};

function page(title, inner, status = 200) {
  return new Response(
    `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><link rel="stylesheet" href="/app.css"></head><body class="connect"><main class="card narrow"><h1>${esc(title)}</h1>${inner}
<p><a class="btn ghost wide" href="/#autopilot">Open Marketing Hub</a></p></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

function card(post) {
  if (!post) return '';
  const thumb = post.media?.find((m) => m.thumb)?.thumb;
  return `<article class="post">${thumb ? `<img src="${esc(thumb)}" alt="">` : '<div class="ph"></div>'}<div><div class="meta">${post.scheduledAt ? esc(fmt(post.scheduledAt)) : ''}${post.auto ? ' · re-share of a past post' : ''}</div><p class="cap">${esc(post.caption)}</p></div></article>`;
}

const expired = () => page('This link has expired', '<p>Links in the morning email work for 3 days. Open the app to make changes.</p>', 410);

export async function GET(request) {
  const t = new URL(request.url).searchParams.get('t');
  const d = readActionToken(t);
  if (!d) return expired();
  const post = await getPost(d.id);
  if (!post || post.status !== 'scheduled') return page('Nothing to do', `<p>${post?.status === 'published' ? 'That post has already gone out.' : 'That post is no longer waiting (it may already have been changed).'}</p>`);
  const w = WORDS[d.a];
  return page(w.ask, `${card(post)}<form method="post" action="/api/act?t=${encodeURIComponent(t)}"><button class="btn wide big" type="submit">${esc(w.yes)}</button></form>`);
}

export async function POST(request) {
  const d = readActionToken(new URL(request.url).searchParams.get('t'));
  if (!d) return expired();
  try {
    const r = await { approve, skip, swap }[d.a](d.id);
    const w = WORDS[d.a];
    const extra = d.a === 'swap' ? (r.next ? `<p>Autopilot picked this one instead:</p>${card({ ...r.next, media: [{ thumb: r.next.thumb }] })}` : `<p>${esc(r.note)}</p>`) : `<p>${esc(w.after)}</p>`;
    return page(w.done, extra);
  } catch (err) {
    return page("That didn't work", `<p>${esc(err.userMessage || 'Something went wrong. Open the app to check.')}</p>`, err.status || 500);
  }
}
