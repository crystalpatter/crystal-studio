// End-to-end tests against the pretend Meta API (no real posting).
//   node dev/test-publish.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMockGraph } from './mock-graph.js';

const STORE = new URL('../.devdata/test-store.json', import.meta.url);
fs.rmSync(STORE, { force: true });
Object.assign(process.env, {
  GRAPH_BASE: 'http://localhost:5198',
  META_PAGE_TOKEN: 'test-token',
  APP_PASSWORD: 'correct horse',
  DEV_STORE_FILE: '../.devdata/test-store.json',
  ALLOW_HTTP_MEDIA: '1',
});

const mock = await startMockGraph({ port: 5198, videoPolls: 2, fail: { 'PAGE1/videos': { times: 3, error: { code: 1, message: 'An unknown error occurred', is_transient: true } } } });
const { advance, runDue, facebookCaption } = await import('../lib/publisher.js');
const store = await import('../lib/store.js');
const { check } = await import('../public/js/guardrails.js');
const login = await import('../api/login.js');
const postsApi = await import('../api/posts.js');
const postApi = await import('../api/post.js');
const statusApi = await import('../api/status.js');
const insightsApi = await import('../api/insights.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('✓', name);
  } catch (err) {
    console.error('✗', name);
    console.error(err);
    process.exitCode = 1;
  }
}
const req = (path, { method = 'GET', body, cookie } = {}) =>
  new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const callsTo = (p) => mock.calls.filter((c) => c.path === p);

let cookie;
await test('login rejects a wrong password and accepts the right one', async () => {
  const bad = await login.POST(req('/api/login', { method: 'POST', body: { password: 'nope' } }));
  assert.equal(bad.status, 401);
  const good = await login.POST(req('/api/login', { method: 'POST', body: { password: 'correct horse' } }));
  assert.equal(good.status, 200);
  cookie = good.headers.get('set-cookie').split(';')[0];
});

await test('API refuses requests without the login cookie', async () => {
  const r = await postsApi.GET(req('/api/posts'));
  assert.equal(r.status, 401);
});

await test('status reports the connected Instagram account', async () => {
  const s = await (await statusApi.GET(req('/api/status', { cookie }))).json();
  assert.equal(s.meta.igUsername, 'bycrystalcosmetics');
  assert.equal(s.meta.pageId, 'PAGE1');
});

await test('single photo posts to Instagram, then Facebook with the booking link', async () => {
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/a.jpg', kind: 'image' }], caption: 'Soft healed lips. Book via the link in bio.\n\n#lipblush', toFacebook: true } }));
  const { post } = await r.json();
  assert.equal(post.status, 'published', JSON.stringify(post.log));
  assert.equal(post.ig.permalink.startsWith('https://www.instagram.com/p/'), true);
  const ig = callsTo('IG1/media').at(-1).params;
  assert.equal(ig.image_url, 'http://x/a.jpg');
  assert.match(ig.caption, /link in bio/);
  const fb = callsTo('PAGE1/photos').at(-1).params;
  assert.match(fb.message, /Book online: www\.crystalcosmetics\.com\.au/);
  assert.doesNotMatch(fb.message, /link in bio/);
});

await test('carousel: one container per item, then a CAROUSEL container, then a multi-photo Facebook post', async () => {
  const before = callsTo('IG1/media').length;
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [1, 2, 3].map((i) => ({ url: `http://x/${i}.jpg`, kind: 'image' })), caption: 'Brows three ways', toFacebook: true } }));
  const { post } = await r.json();
  assert.equal(post.status, 'published', JSON.stringify(post.log));
  const created = callsTo('IG1/media').slice(before);
  assert.equal(created.length, 4);
  assert.equal(created.filter((c) => c.params.is_carousel_item === 'true').length, 3);
  assert.equal(created[3].params.media_type, 'CAROUSEL');
  assert.equal(created[3].params.children.split(',').length, 3);
  const feed = callsTo('PAGE1/feed').at(-1).params;
  assert.equal(JSON.parse(feed.attached_media).length, 3);
});

await test('Reel waits for Instagram processing across several calls, and Facebook errors retry then mark "partial"', async () => {
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/v.mp4', kind: 'video' }], caption: 'Lip blush in 15 seconds', toFacebook: true } }));
  let { post } = await r.json();
  // The mock says IN_PROGRESS twice, then FINISHED; with a tiny budget we come back several times.
  for (let i = 0; i < 6 && post.ig.status !== 'done'; i++) post = (await advance(post.id, { budgetMs: 1 })).post;
  assert.equal(post.ig.status, 'done');
  assert.equal(callsTo('IG1/media').at(-1).params.media_type, 'REELS');
  assert.equal(callsTo('IG1/media').at(-1).params.share_to_feed, 'true');
  // Facebook video upload fails 3 times (transient) → after 3 tries it's marked failed → 'partial'.
  for (let i = 0; i < 4 && post.status === 'publishing'; i++) post = (await advance(post.id, { budgetMs: 1 })).post;
  assert.equal(post.status, 'partial');
  assert.equal(post.fb.tries, 3);
  // Retry from the calendar now succeeds (mock stops failing).
  const retry = await postApi.PATCH(req(`/api/post?id=${post.id}`, { method: 'PATCH', cookie, body: { action: 'retry' } }));
  post = (await retry.json()).post;
  assert.equal(post.status, 'published');
  assert.equal(callsTo('IG1/media_publish').filter((c) => c.params.creation_id === post.ig.container).length, 1, 'Instagram must not be published twice');
});

await test('scheduled post waits until its time, then the scheduler publishes it', async () => {
  const when = Date.now() + 3600_000;
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/s.jpg', kind: 'image' }], caption: 'Wednesday education', toFacebook: false, scheduledAt: when } }));
  let { post } = await r.json();
  assert.equal(post.status, 'scheduled');
  const publishesBefore = callsTo('IG1/media_publish').length;
  await runDue();
  assert.equal((await store.getPost(post.id)).status, 'scheduled');
  assert.equal(callsTo('IG1/media_publish').length, publishesBefore);
  // Pretend time has passed:
  post.scheduledAt = Date.now() - 1000;
  await store.savePost(post);
  await store.enqueue(post.id, post.scheduledAt);
  const results = await runDue();
  assert.deepEqual(results.map((x) => x.status), ['published']);
  const saved = await store.getPost(post.id);
  assert.equal(saved.fb.status, 'off');
  assert.equal(callsTo('PAGE1/photos').filter((c) => c.params.url === 'http://x/s.jpg').length, 0, 'Facebook toggle off → nothing sent to Facebook');
});

await test('a container that already went live is not published twice', async () => {
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/d.jpg', kind: 'image' }], caption: 'dup check', toFacebook: false, scheduledAt: Date.now() + 3600_000 } }));
  const { post } = await r.json();
  // Simulate: container created and published on Meta's side, but we never heard back.
  const c = await (await fetch('http://localhost:5198/v26.0/IG1/media', { method: 'POST', body: new URLSearchParams({ image_url: 'http://x/d.jpg', access_token: 'test-token' }) })).json();
  mock.containers[c.id].published = true;
  Object.assign(post, { scheduledAt: Date.now() - 1, ig: { ...post.ig, container: c.id } });
  await store.savePost(post);
  const before = callsTo('IG1/media_publish').length;
  const out = (await advance(post.id)).post;
  assert.equal(out.status, 'published');
  assert.equal(callsTo('IG1/media_publish').length, before);
});

await test('scheduled posts can be moved, posted now, or cancelled', async () => {
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/e.jpg', kind: 'image' }], caption: 'Friday BTS', toFacebook: true, scheduledAt: Date.now() + 7200_000 } }));
  const { post } = await r.json();
  const later = Date.now() + 86400_000;
  const moved = await (await postApi.PATCH(req(`/api/post?id=${post.id}`, { method: 'PATCH', cookie, body: { scheduledAt: later } }))).json();
  assert.equal(moved.post.scheduledAt, later);
  const now = await (await postApi.PATCH(req(`/api/post?id=${post.id}`, { method: 'PATCH', cookie, body: { action: 'now' } }))).json();
  assert.equal(now.post.status, 'published');
  const r2 = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/f.jpg', kind: 'image' }], caption: 'to cancel', scheduledAt: Date.now() + 7200_000 } }));
  const p2 = (await r2.json()).post;
  const del = await postApi.DELETE(req(`/api/post?id=${p2.id}`, { method: 'DELETE', cookie }));
  assert.equal(del.status, 200);
  assert.equal(await store.getPost(p2.id), null);
});

await test('an expired token fails straight away with a plain-English "Reconnect" message (no pointless retries)', async () => {
  process.env.META_PAGE_TOKEN = 'expired';
  try {
    const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/g.jpg', kind: 'image' }], caption: 'x' } }));
    const { post } = await r.json();
    assert.match(post.ig.error, /Reconnect/);
    assert.equal(post.status, 'failed');
    assert.equal(post.ig.tries, 1);
    await store.deletePost(post.id);
  } finally {
    process.env.META_PAGE_TOKEN = 'test-token';
  }
});

await test('a temporary Meta hiccup is retried later rather than failing', async () => {
  const before = mock.calls.length;
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/h.jpg', kind: 'image' }], caption: 'retry me', toFacebook: false, scheduledAt: Date.now() + 3600_000 } }));
  let { post } = await r.json();
  post.scheduledAt = Date.now() - 1;
  await store.savePost(post);
  mock.failNext('IG1/media', { code: 2, message: 'Service temporarily unavailable', is_transient: true });
  post = (await advance(post.id)).post;
  assert.equal(post.status, 'publishing');
  assert.equal(post.ig.tries, 1);
  post = (await advance(post.id)).post;
  assert.equal(post.status, 'published');
  assert.ok(mock.calls.length > before);
});

await test('calendar lists posts in range', async () => {
  const { posts } = await (await postsApi.GET(req('/api/posts', { cookie }))).json();
  assert.ok(posts.length >= 5);
});

await test('insights: shows the metrics Meta returns and skips ones it rejects', async () => {
  const d = await (await insightsApi.GET(req('/api/insights?fresh=1', { cookie }))).json();
  assert.equal(d.followers, 763);
  assert.ok(d.totals.find((t) => t.metric === 'reach'));
  assert.ok(!d.totals.find((t) => t.metric === 'profile_links_taps'));
  assert.equal(d.media[0].stats.saved, 5);
});

await test('guardrails flag the brief\'s "Never" list but not normal captions', () => {
  for (const bad of ['10+ years of beauty', 'Over 500 happy clients', 'Gold Coast\'s best lip blush', 'Become certified', 'Totally painless', 'We also do lash extensions', 'Powder brows with hair strokes', '5 star service', 'most trusted studio'])
    assert.ok(check(bad).length, `should flag: ${bad}`);
  for (const ok of ['Soft, natural lip blush in Varsity Lakes. Lasts 2–5 years depending on your skin.', 'Powder brows: soft shading, like brow powder that stays. DM "BROWS" to book.', 'Lip blush $550. Touch-up $200 at 4–6 weeks.'])
    assert.deepEqual(check(ok), [], `should not flag: ${ok}`);
});

await test('Facebook caption swaps "link in bio" for the website', () => {
  assert.equal(facebookCaption('Tap the link in bio to book'), 'Tap the link below to book\n\nBook online: www.crystalcosmetics.com.au');
  assert.equal(facebookCaption('Book via link in my bio.\n\n#lipblush #goldcoast'), 'Book via link below.\n\nBook online: www.crystalcosmetics.com.au\n\n#lipblush #goldcoast');
  assert.equal(facebookCaption('Book at www.crystalcosmetics.com.au'), 'Book at www.crystalcosmetics.com.au');
});

mock.close();
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
