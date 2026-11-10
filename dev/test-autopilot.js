// Tests for Autopilot, the website counter and the morning report, against a
// pretend Meta API and a pretend email service (nothing real is posted or sent).
//   node dev/test-autopilot.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startMockGraph } from './mock-graph.js';

const STORE = new URL('../.devdata/test-autopilot-store.json', import.meta.url);
fs.rmSync(STORE, { force: true });
Object.assign(process.env, {
  GRAPH_BASE: 'http://localhost:5197',
  META_PAGE_TOKEN: 'test-token',
  META_APP_ID: '123',
  META_APP_SECRET: '0123456789abcdef0123456789abcdef',
  APP_PASSWORD: 'correct horse',
  DEV_STORE_FILE: '../.devdata/test-autopilot-store.json',
  ALLOW_HTTP_MEDIA: '1',
  APP_URL: 'https://studio.test',
  RESEND_BASE: 'http://localhost:5196',
  HEALTH_WEBSITE: 'http://localhost:5196/site',
  HEALTH_BOOKING: 'http://localhost:5196/book',
});
delete process.env.RESEND_API_KEY;

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const old = (id, daysAgo, caption, extra = {}) => ({ id, caption, media_type: 'IMAGE', media_product_type: 'FEED', timestamp: iso(daysAgo), permalink: `https://www.instagram.com/p/${id}/`, media_url: `http://cdn.test/${id}.jpg`, like_count: 10, comments_count: 1, ...extra });
const MEDIA = [
  old('OLD1', 200, 'Healed lip blush, soft and rosy. DM "LIPS" to book.'), // good, mid reach
  old('OLD2', 300, 'Powder brows, one week healed. Book via the link in bio.', { media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'http://cdn.test/OLD2-thumb.jpg', media_url: 'http://cdn.test/OLD2.mp4' }), // best
  old('OLD3', 400, 'Christmas special: lip blush $450 this week only!'), // dated + price
  old('OLD4', 10, 'Fresh brows from this month.'), // too recent
  old('OLD5', 500, 'Lips to music', { media_type: 'VIDEO', media_product_type: 'REELS', media_url: undefined }), // no file (licensed music)
  old('OLD6', 350, "Gold Coast's best lip blush, totally painless."), // breaks the brief
  old('OLD7', 250, 'Three brow shapes, swipe through.', { media_type: 'CAROUSEL_ALBUM', media_url: undefined, children: { data: [{ media_type: 'IMAGE', media_url: 'http://cdn.test/7a.jpg' }, { media_type: 'IMAGE', media_url: 'http://cdn.test/7b.jpg' }] } }),
];
const INSIGHTS = { OLD1: { reach: 900, saved: 12, shares: 3 }, OLD2: { reach: 2400, saved: 40, shares: 22 }, OLD3: { reach: 9000, saved: 90, shares: 50 }, OLD4: { reach: 5000 }, OLD5: { reach: 7000 }, OLD6: { reach: 8000 }, OLD7: { reach: 600, saved: 5, shares: 1 } };

const mock = await startMockGraph({ port: 5197, videoPolls: 0, media: MEDIA, insights: INSIGHTS });

// Pretend email service + pretend website
const mails = [];
let mailMode = 'ok';
const side = http
  .createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/emails') {
      const m = JSON.parse(body);
      if (mailMode === 'no-scheduling' && m.scheduled_at) {
        res.writeHead(422, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Scheduling emails is not available on your plan' }));
      }
      mails.push({ ...m, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: `mail${mails.length}` }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<a href="https://bookings.gettimely.com/crystalcosmetics/bb/book">Book</a>');
  })
  .listen(5196);

const store = await import('../lib/store.js');
const { saveConfig, getConfig } = await import('../lib/config.js');
const ap = await import('../lib/autopilot.js');
const ever = await import('../lib/evergreen.js');
const web = await import('../lib/web.js');
const links = await import('../lib/links.js');
const token = await import('../lib/token.js');
const { advance } = await import('../lib/publisher.js');
const { buildReport, renderEmail, renderText, subject } = await import('../lib/report.js');
const { sendDaily } = await import('../lib/daily.js');
const T = await import('../lib/time.js');
const statusApi = await import('../api/status.js');
const postsApi = await import('../api/posts.js');
const apApi = await import('../api/autopilot.js');
const actApi = await import('../api/act.js');
const tApi = await import('../api/t.js');
const cronApi = await import('../api/cron.js');

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
const req = (path, { method = 'GET', body, cookie, headers = {} } = {}) =>
  new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const cookie = (await statusApi.POST(req('/api/status', { method: 'POST', body: { password: 'correct horse' } }))).headers.get('set-cookie').split(';')[0];

// "Now" for the tests: 9am today, Gold Coast time, with today as the only posting day.
const p0 = T.parts(Date.now());
const NOW = T.at(p0.y, p0.mo, p0.d, 9, 0);
const SLOT = T.at(p0.y, p0.mo, p0.d, 18, 0);
await saveConfig({ days: [p0.dow], hour: 18, minute: 0, emailTo: 'owner@example.com' });
const wipeDay = async () => {
  for (const p of await store.listPosts(NOW - 2 * DAY, NOW + 2 * DAY)) {
    await store.dequeue(p.id);
    await store.bankRemove(p.id);
    await store.deletePost(p.id);
  }
  await store.kvDel(`skip:${T.dayKey(NOW)}`);
  await store.kvDel('resting');
};

await test('time helpers use Gold Coast time (UTC+10, no daylight saving)', () => {
  const ms = Date.UTC(2026, 10, 10, 22, 0); // 10 Nov 22:00 UTC = 11 Nov 8:00am Gold Coast
  assert.deepEqual(T.parts(ms), { y: 2026, mo: 10, d: 11, dow: 3, h: 8, mi: 0 });
  assert.equal(T.dayKey(ms), '2026-11-11');
  assert.equal(T.at(2026, 10, 11, 8, 0), ms);
});

await test('settings: only sensible values are saved', async () => {
  const c = await saveConfig({ days: [1, 3, 9, 'x', 3], hour: 2, approval: 'whatever', autopilot: 'yes' });
  assert.deepEqual(c.days, [1, 3]);
  assert.equal(c.hour, 18);
  assert.equal(c.approval, 'auto');
  assert.equal(c.autopilot, true);
  await assert.rejects(() => saveConfig({ emailTo: 'not an email' }));
  await saveConfig({ days: [p0.dow] });
});

await test('"Add to bank" saves a post with no date and keeps it off the calendar', async () => {
  const r = await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/bank1.jpg', kind: 'image' }], caption: 'Bank post one', bank: true } }));
  const { post } = await r.json();
  assert.equal(post.status, 'banked');
  assert.equal(post.scheduledAt, null);
  assert.equal(mock.calls.filter((c) => c.path === 'IG1/media' && c.method === 'POST').length, 0, 'nothing is sent to Instagram yet');
  const cal = await (await postsApi.GET(req('/api/posts', { cookie }))).json();
  assert.equal(cal.posts.length, 0);
  const s = await (await apApi.GET(req('/api/autopilot', { cookie }))).json();
  assert.equal(s.bank.length, 1);
  assert.equal(s.next.fill.kind, 'bank');
});

await test('on a posting day Autopilot gives the oldest banked post that day’s slot, once', async () => {
  await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/bank2.jpg', kind: 'image' }], caption: 'Bank post two', bank: true } }));
  const r = await ap.plan(NOW);
  assert.equal(r.did, 'bank');
  assert.equal(r.post.caption, 'Bank post one');
  assert.equal(r.post.scheduledAt, SLOT);
  assert.equal((await ap.plan(NOW)).did, 'already-booked');
  assert.equal((await store.bankList()).length, 1);
  assert.deepEqual(await store.dueIds(SLOT + 1000), [r.post.id]);
});

await test('skipping a banked post puts it back in the bank and leaves the day empty', async () => {
  const [p] = (await store.listPosts(NOW - DAY, NOW + DAY)).filter((x) => x.status === 'scheduled');
  assert.equal((await ap.skip(p.id)).did, 'skipped');
  assert.equal((await store.getPost(p.id)).status, 'banked');
  assert.equal((await store.bankList())[0].caption, 'Bank post one', 'goes back to the front of the queue');
  assert.equal((await ap.plan(NOW)).did, 'skipped-today');
  await wipeDay();
});

await test('re-share picker: ranks past posts and rules out recent, dated, off-brief and unavailable ones', async () => {
  const list = await ever.ranked({ fresh: true });
  assert.equal(list[0].id, 'OLD3', 'highest raw score');
  const ok = await ever.candidates({});
  assert.deepEqual(ok.map((c) => c.id), ['OLD2', 'OLD1', 'OLD7']);
  const why = Object.fromEntries(list.map((i) => [i.id, ever.whyNot(i, {})]));
  assert.match(why.OLD3, /price|best|date/i);
  assert.match(why.OLD4, /less than 45 days/);
  assert.match(why.OLD5, /original file/);
  assert.match(why.OLD6, /best|painless/i);
  assert.deepEqual(ever.reuseProblems('Soft healed lips in Varsity Lakes. DM "LIPS" to book.'), []);
  assert.ok(ever.reuseProblems('Two spots left this week').length);
  assert.ok(ever.reuseProblems('Find me at Shop 5b').length);
});

await test('empty bank on a posting day → the best past post is re-shared to Instagram and Facebook', async () => {
  const r = await ap.plan(NOW);
  assert.equal(r.did, 'repost');
  assert.equal(r.post.source.mediaId, 'OLD2');
  assert.equal(r.post.auto, true);
  assert.equal(r.post.type, 'reel');
  const post = await store.getPost(r.post.id);
  assert.equal(post.scheduledAt, SLOT);
  assert.equal((await advance(post.id)).post.status, 'scheduled', 'does not go out before its time');
  post.scheduledAt = Date.now() - 1000;
  await store.savePost(post);
  const out = (await advance(post.id)).post;
  assert.equal(out.status, 'published', JSON.stringify(out.log));
  const sent = mock.calls.filter((c) => c.path === 'IG1/media' && c.method === 'POST').at(-1).params;
  assert.equal(sent.video_url, 'http://cdn.test/OLD2.mp4');
  assert.match(sent.caption, /Powder brows/);
  assert.ok(mock.calls.some((c) => c.path === 'PAGE1/videos'));
  // It now rests for 4 months, and the copy that went live is never picked as a "past post".
  assert.deepEqual((await ever.candidates({ now: NOW })).map((c) => c.id), ['OLD1', 'OLD7']);
  await wipeDay();
});

await test('"Pick another" drops the choice, rests it, and lines up the next best', async () => {
  const first = (await ap.plan(NOW)).post;
  assert.equal(first.source.mediaId, 'OLD2');
  const r = await ap.swap(first.id);
  assert.equal(r.next.source.mediaId, 'OLD1');
  assert.equal(await store.getPost(first.id), null);
  await wipeDay();
});

await test('"ask first" mode: a re-share waits for approval and never posts without it', async () => {
  await saveConfig({ approval: 'ask' });
  const r = await ap.plan(NOW);
  assert.equal(r.post.hold, true);
  const post = await store.getPost(r.post.id);
  post.scheduledAt = Date.now() - 1000;
  await store.savePost(post);
  const before = mock.calls.filter((c) => c.path === 'IG1/media_publish').length;
  assert.equal((await advance(post.id)).post.status, 'scheduled');
  assert.equal(mock.calls.filter((c) => c.path === 'IG1/media_publish').length, before, 'nothing published while waiting');

  // The email's Approve link: opening it only shows a confirm page…
  const link = links.actionLink('approve', post.id);
  assert.ok(link.startsWith('https://studio.test/api/act?t='));
  const t = new URL(link).searchParams.get('t');
  const page = await actApi.GET(req(`/api/act?t=${encodeURIComponent(t)}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Approve this post\?/);
  assert.equal((await store.getPost(post.id)).hold, true, 'opening the link changes nothing');
  // …tampered or expired links do nothing…
  assert.equal((await actApi.POST(req(`/api/act?t=${encodeURIComponent(t.slice(0, -2) + 'xx')}`, { method: 'POST' }))).status, 410);
  assert.equal(links.readActionToken(links.actionToken('approve', post.id, -1000)), null);
  // …and pressing the button approves it.
  const done = await actApi.POST(req(`/api/act?t=${encodeURIComponent(t)}`, { method: 'POST' }));
  assert.match(await done.text(), /Approved/);
  assert.equal((await advance(post.id)).post.status, 'published');
  await saveConfig({ approval: 'auto' });
  await wipeDay();
});

await test('Autopilot off, or re-sharing off, means nothing is lined up', async () => {
  await saveConfig({ fallback: false });
  assert.equal((await ap.plan(NOW)).did, 'empty');
  await saveConfig({ fallback: true, autopilot: false });
  assert.equal((await ap.plan(NOW)).did, 'off');
  await saveConfig({ autopilot: true, days: [(p0.dow + 1) % 7] });
  assert.equal((await ap.plan(NOW)).did, 'no-slot-today');
  await saveConfig({ days: [p0.dow] });
});

await test('a post Crystal scheduled herself for today means Autopilot leaves the day alone', async () => {
  await postsApi.POST(req('/api/posts', { method: 'POST', cookie, body: { media: [{ url: 'http://x/own.jpg', kind: 'image' }], caption: 'My own post', scheduledAt: Date.now() + 3600_000 } }));
  const mine = (await store.listPosts(Date.now() - DAY, Date.now() + DAY)).find((p) => p.caption === 'My own post');
  if (T.dayKey(mine.scheduledAt) === T.dayKey(NOW)) assert.equal((await ap.plan(NOW)).did, 'already-booked');
  await wipeDay();
});

await test('website counter: counts visits, sources and booking taps; ignores other sites and bots', async () => {
  const site = { origin: 'https://www.crystalcosmetics.com.au', 'user-agent': 'Mozilla/5.0 (iPhone)' };
  const ping = (b, headers = site) => tApi.POST(new Request('http://localhost/api/t', { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: JSON.stringify(b) }));
  const r = await ping({ e: 'pv', s: 'instagram', p: '/', n: 1 });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://www.crystalcosmetics.com.au');
  await ping({ e: 'pv', s: 'instagram', p: '/services/lip-blush-gold-coast.html', n: 0 });
  await ping({ e: 'book', s: 'instagram', p: '/services/lip-blush-gold-coast.html' });
  await ping({ e: 'pv', s: 'google-ads', p: '/', n: 1 });
  await ping({ e: 'pv', s: 'direct', p: '/', n: 1 });
  await ping({ e: 'call', s: 'direct', p: '/contact.html' });
  await ping({ e: 'pv', s: 'instagram', p: '/', n: 1 }, { origin: 'https://evil.example', 'user-agent': 'Mozilla/5.0' });
  await ping({ e: 'pv', s: 'instagram', p: '/', n: 1 }, { ...site, 'user-agent': 'Googlebot/2.1' });
  await ping({ e: 'hack', s: '<script>', p: '/' });
  const s = await web.summary(Date.now());
  assert.equal(s.tracking, true);
  assert.equal(s.today.visits, 3);
  assert.equal(s.today.pageviews, 4);
  assert.equal(s.today.book, 1);
  assert.equal(s.today.call, 1);
  assert.equal(s.today.googleAdsVisits, 1);
  assert.deepEqual(s.today.sources[0], { key: 'instagram', label: 'Instagram', visits: 1, book: 1 });
});

await test('the Facebook connection is stored encrypted and preferred over the old Vercel setting', async () => {
  await token.saveToken('test-token', { page: 'Crystal Cosmetics', ig: 'bycrystalcosmetics' });
  const raw = JSON.stringify(await store.kvGet('metatoken'));
  assert.ok(!raw.includes('test-token'), 'not stored in plain text');
  assert.equal(await token.loadToken(), 'test-token');
  const keep = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'ffffffffffffffffffffffffffffffff';
  assert.equal(await token.loadToken(), null, 'unreadable without the right key');
  process.env.META_APP_SECRET = keep;
  await token.clearToken();
});

await test('morning report: connection check, posts, Instagram, website and "needs you"', async () => {
  await store.kvSet('heartbeat', { at: Date.now(), by: 'vercel' });
  const r = await buildReport(Date.now());
  const check = Object.fromEntries(r.checks.map((c) => [c.key, c.ok]));
  assert.equal(check.instagram, true);
  assert.equal(check.facebook, true);
  assert.equal(check.website, true);
  assert.equal(check.booking, true);
  assert.equal(check.scheduler, true);
  assert.equal(check.email, false, 'email key not added yet');
  assert.equal(r.ig.followers, 763);
  assert.equal(r.fb.followers, 412);
  assert.ok(r.needs.some((n) => /content bank is empty/.test(n.text)));
  const html = renderEmail(r);
  for (const bit of ['Morning report', 'Connection check', 'Instagram @bycrystalcosmetics', 'Website → bookings', 'Taps on “Book”', 'Visitors from Google Ads', 'Open Crystal Studio']) assert.ok(html.includes(bit), `email should mention: ${bit}`);
  assert.ok(!html.includes('undefined') && !html.includes('NaN'), 'no stray undefined/NaN in the email');
  assert.match(renderText(r), /CONNECTIONS/);
  assert.match(subject(r), /Crystal Cosmetics/);
});

await test('morning report says so plainly when Instagram is disconnected', async () => {
  process.env.META_PAGE_TOKEN = 'expired';
  const { forgetToken } = await import('../lib/graph.js');
  forgetToken();
  try {
    const r = await buildReport(Date.now());
    assert.equal(r.checks.find((c) => c.key === 'instagram').ok, false);
    assert.match(subject(r), /^⚠.*need reconnecting/);
    assert.ok(renderEmail(r).includes('Reconnect'));
  } finally {
    process.env.META_PAGE_TOKEN = 'test-token';
    forgetToken();
  }
});

await test('daily email: built at 7am and held for 8:00, sent once, never twice', async () => {
  process.env.RESEND_API_KEY = 're_test';
  const seven = T.at(p0.y, p0.mo, p0.d, 7, 20);
  const eight = T.at(p0.y, p0.mo, p0.d, 8, 0);
  assert.equal((await sendDaily(T.at(p0.y, p0.mo, p0.d, 5, 0))).did, 'not-yet');
  const r = await sendDaily(seven);
  assert.equal(r.did, 'scheduled-for-8');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to[0], 'owner@example.com');
  assert.equal(mails[0].scheduled_at, new Date(eight).toISOString());
  assert.equal(mails[0].auth, 'Bearer re_test');
  assert.match(mails[0].subject, /Crystal Cosmetics/);
  assert.ok(mails[0].html.includes('Morning report') && mails[0].text.includes('CONNECTIONS'));
  assert.equal((await sendDaily(eight + 60000)).did, 'already');
  assert.equal(mails.length, 1);
  assert.ok((await store.kvGet('report-latest')).html.includes('Morning report'), 'the app can show the latest report');
});

await test('daily email: if the service cannot hold emails, it goes on the first run after 8am instead', async () => {
  await store.kvDel(`report-done:${T.dayKey(NOW)}`);
  mailMode = 'no-scheduling';
  assert.equal((await sendDaily(T.at(p0.y, p0.mo, p0.d, 7, 20))).did, 'waiting-for-8');
  assert.equal((await sendDaily(T.at(p0.y, p0.mo, p0.d, 7, 40))).did, 'waiting-for-8');
  assert.equal(mails.length, 1);
  const r = await sendDaily(T.at(p0.y, p0.mo, p0.d, 8, 10));
  assert.equal(r.did, 'sent');
  assert.equal(mails.length, 2);
  assert.equal(mails[1].scheduled_at, undefined);
  mailMode = 'ok';
});

await test('daily email: without an email key the report is still saved, and nothing is sent', async () => {
  await store.kvDel(`report-done:${T.dayKey(NOW)}`);
  delete process.env.RESEND_API_KEY;
  const r = await sendDaily(T.at(p0.y, p0.mo, p0.d, 8, 10));
  assert.equal(r.did, 'saved-not-sent');
  assert.equal(mails.length, 2);
});

await test('the scheduler endpoint publishes, plans and records a heartbeat in one call', async () => {
  await store.kvDel('heartbeat');
  const out = await (await cronApi.GET(req('/api/cron', { headers: { 'user-agent': 'vercel-cron/1.0' } }))).json();
  assert.equal(out.ok, true);
  assert.ok('autopilot' in out && 'report' in out);
  assert.equal((await store.kvGet('heartbeat')).by, 'vercel');
});

await test('Autopilot screen API: change settings, and needs the login', async () => {
  assert.equal((await apApi.GET(req('/api/autopilot'))).status, 401);
  const s = await (await apApi.PATCH(req('/api/autopilot', { method: 'PATCH', cookie, body: { hour: 12, minute: 30, toFacebook: false } }))).json();
  assert.equal(s.config.hour, 12);
  assert.equal(s.config.minute, 30);
  assert.equal(s.config.toFacebook, false);
  assert.equal(s.mail.to, 'owner@example.com');
});

mock.close();
side.close();
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
