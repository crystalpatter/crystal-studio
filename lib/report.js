// Builds the morning report: connections, posts, Instagram, website traffic
// and booking taps. buildReport() gathers the numbers; renderEmail() turns
// them into the email (the same HTML is shown in the app's Autopilot tab).
import { graph } from './graph.js';
import { getConfig, reportRecipient } from './config.js';
import { listPosts, kvGet, kvSet } from './store.js';
import { runChecks } from './health.js';
import { preview, brief, slotOn } from './autopilot.js';
import { ranked } from './evergreen.js';
import { summary as webSummary } from './web.js';
import { collectLeads } from './leads.js';
import { actionLink, appUrl } from './links.js';
import { DAY, dayKey, dayStart, fmt, fmtDay, fmtTime } from './time.js';

const IG_METRICS = [
  ['reach', 'Accounts reached'],
  ['views', 'Views'],
  ['profile_views', 'Profile visits'],
  ['profile_links_taps', 'Link & button taps'],
  ['accounts_engaged', 'Accounts engaged'],
  ['total_interactions', 'Likes, saves, shares, comments'],
];

async function igTotals(igId, since, until) {
  const out = {};
  await Promise.all(
    IG_METRICS.map(async ([metric]) => {
      try {
        const r = await graph('GET', `${igId}/insights`, { metric, period: 'day', metric_type: 'total_value', since: Math.floor(since / 1000), until: Math.floor(until / 1000) });
        const v = r.data?.[0]?.total_value?.value;
        if (typeof v === 'number') out[metric] = v;
      } catch {
        /* this number isn't available: leave it out */
      }
    })
  );
  return out;
}

export async function buildReport(now = Date.now()) {
  const cfg = await getConfig();
  const today = dayStart(now);
  const day = dayKey(now);
  const app = appUrl();
  const { checks, account } = await runChecks(now);

  // ---- posts ----
  const [yPosts, tPosts, uPosts, next] = await Promise.all([listPosts(today - DAY, today - 1), listPosts(today, today + DAY - 1), listPosts(today + DAY, today + 8 * DAY), preview(now)]);
  const live = (p) => p.status !== 'banked';
  const posts = {
    yesterday: yPosts.filter(live).map(brief),
    today: tPosts.filter(live).map(brief),
    upcoming: uPosts.filter((p) => p.status === 'scheduled').map(brief),
    bank: next.bank,
    perWeek: cfg.days.length,
    next,
    autopilot: cfg.autopilot,
    todayIsPostingDay: Boolean(slotOn(cfg, now)),
  };

  // ---- Instagram + Facebook ----
  let ig = null;
  let fb = null;
  const prevSnap = (await kvGet(`snap:${dayKey(now - DAY)}`)) || null;
  let snap = { at: now, followers: null, pageFollowers: null, comments: null };
  if (account?.igId) {
    const [yesterday, week, prevWeek, list] = await Promise.all([
      igTotals(account.igId, today - DAY, today),
      igTotals(account.igId, today - 7 * DAY, today),
      igTotals(account.igId, today - 14 * DAY, today - 7 * DAY),
      ranked({ now }).catch(() => []),
    ]);
    const comments = list.reduce((n, m) => n + (m.stats.comments || 0), 0);
    const recent = list.filter((m) => now - m.timestamp < 7 * DAY).sort((a, b) => b.score - a.score);
    snap = { at: now, followers: account.followers, pageFollowers: account.pageFollowers ?? null, comments };
    ig = {
      username: account.igUsername,
      followers: account.followers,
      followersChange: prevSnap?.followers != null && account.followers != null ? account.followers - prevSnap.followers : null,
      newComments: prevSnap?.comments != null ? Math.max(0, comments - prevSnap.comments) : null,
      yesterday,
      week,
      prevWeek,
      postsThisWeek: recent.length,
      top: recent[0] ? { caption: recent[0].caption.slice(0, 140), permalink: recent[0].permalink, thumb: recent[0].thumb, stats: recent[0].stats, type: recent[0].type } : null,
      lastPostAt: list.length ? Math.max(...list.map((m) => m.timestamp)) : null,
    };
    fb = { name: account.pageName, followers: account.pageFollowers ?? null, followersChange: prevSnap?.pageFollowers != null && account.pageFollowers != null ? account.pageFollowers - prevSnap.pageFollowers : null };
  }

  // ---- website ----
  const web = await webSummary(now).catch(() => null);

  // ---- people who engaged (leads) ----
  const leads = await collectLeads(now).catch((err) => ({ available: false, error: err.message, fresh: [], waiting: [], total: 0, status: {} }));

  // ---- things that need Crystal ----
  const needs = [];
  for (const c of checks) if (c.ok === false) needs.push({ text: `${c.label}: ${c.note || 'needs attention'}`, links: c.fix ? [c.fix] : [], level: ['instagram', 'facebook', 'website', 'publishing'].includes(c.key) ? 'high' : 'low' });
  for (const p of posts.today.filter((x) => x.hold && x.status === 'scheduled')) {
    needs.push({
      text: `Approve today's ${fmtTime(p.scheduledAt)} post? It's a re-share of a past top performer and won't go out until you say yes.`,
      links: [{ label: 'Approve', url: actionLink('approve', p.id) }, { label: 'Pick another', url: actionLink('swap', p.id) }, { label: 'Skip today', url: actionLink('skip', p.id) }],
      level: 'high',
      post: p,
    });
  }
  if (cfg.autopilot && posts.bank === 0) {
    needs.push({ text: cfg.fallback ? 'Your content bank is empty. Autopilot will re-share past top posts until you add something new.' : 'Your content bank is empty, so nothing will be posted on your next posting day.', links: [{ label: 'Add a post', url: `${app}/#create` }], level: 'low' });
  } else if (cfg.autopilot && posts.perWeek && posts.bank <= posts.perWeek) {
    needs.push({ text: `Only ${posts.bank} post${posts.bank === 1 ? '' : 's'} left in your content bank (about ${Math.ceil((posts.bank / posts.perWeek) * 7)} days' worth).`, links: [{ label: 'Add more', url: `${app}/#create` }], level: 'low' });
  }

  return { day, generatedAt: now, app, to: reportRecipient(cfg), checks, posts, ig, fb, web, leads, needs, snap };
}

// ---------- email ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-AU') : '–');
const C = { ink: '#2A2118', muted: '#7E6A56', line: '#EADFD0', gold: '#BFA07A', bg: '#FAF8F4', soft: '#F2EBE0', ok: '#3F7D58', warn: '#A8641C', bad: '#A23B3B' };

function change(cur, prev) {
  if (typeof cur !== 'number' || typeof prev !== 'number' || prev === 0) return '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `<span style="color:${C.muted}">no change</span>`;
  return `<span style="color:${pct > 0 ? C.ok : C.bad}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
}
const signed = (n) => (typeof n !== 'number' ? '' : n === 0 ? 'no change' : `${n > 0 ? '+' : ''}${n}`);
const btn = (l) => `<a href="${esc(l.url)}" style="display:inline-block;background:${C.ink};color:#F5E9D6;text-decoration:none;border-radius:999px;padding:8px 16px;font-size:14px;margin:6px 6px 0 0">${esc(l.label)}</a>`;
const section = (title, inner) => `<tr><td style="padding:22px 24px 4px"><div style="font-family:Georgia,serif;font-size:20px;color:${C.ink};border-bottom:1px solid ${C.line};padding-bottom:6px;margin-bottom:10px">${esc(title)}</div>${inner}</td></tr>`;
const p = (html, style = '') => `<p style="margin:6px 0;font-size:15px;line-height:1.5;color:${C.ink};${style}">${html}</p>`;
const small = (html) => `<p style="margin:6px 0;font-size:13px;line-height:1.45;color:${C.muted}">${html}</p>`;
const TYPE = { reel: 'Reel', carousel: 'Carousel', image: 'Photo' };

function postRow(x, extra = '') {
  const when = x.publishedAt || x.scheduledAt;
  const kind = x.auto ? 'Re-share of a past top post' : x.fromBank ? 'From your content bank' : 'Scheduled by you';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0;width:100%"><tr>
${x.thumb ? `<td width="64" valign="top"><img src="${esc(x.thumb)}" width="56" height="70" alt="" style="border-radius:8px;object-fit:cover;display:block"></td>` : ''}
<td valign="top" style="font-size:14px;line-height:1.45;color:${C.ink}"><b>${when ? esc(fmt(when)) : ''}</b> · ${TYPE[x.type] || 'Post'} · <span style="color:${C.muted}">${kind}</span><br>
<span style="color:${C.muted}">${esc(x.caption.slice(0, 110))}${x.caption.length > 110 ? '…' : ''}</span>${x.error && x.status !== 'published' ? `<br><span style="color:${C.bad}">${esc(x.error)}</span>` : ''}${x.permalink ? `<br><a href="${esc(x.permalink)}" style="color:${C.ink}">View on Instagram</a>` : ''}${extra}</td></tr></table>`;
}

function statTable(rows) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;color:${C.ink};border-collapse:collapse">${rows
    .map((r, i) => `<tr style="${i ? `border-top:1px solid ${C.line}` : ''}">${r.map((c, j) => `<td style="padding:6px 4px;${j ? 'text-align:right;white-space:nowrap' : ''}${r.head ? `;color:${C.muted};font-size:12px` : ''}">${c}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}
const head = (cells) => Object.assign(cells, { head: true });

function leadRow(x) {
  const i = x.latest;
  const did = i.kind === 'comment' ? `commented “${esc(i.text)}”` : `reacted (${esc(i.text)})`;
  const state = i.kind !== 'comment' ? '' : x.waiting ? ` · <span style="color:${C.warn}">no reply yet</span>` : ` · <span style="color:${C.ok}">replied ✓</span>`;
  return `<tr style="border-top:1px solid ${C.line}"><td style="padding:8px 4px;font-size:14px;line-height:1.45;color:${C.ink}">
<a href="${esc(x.url)}" style="color:${C.ink};font-weight:600">${esc(x.name)}</a> <span style="color:${C.muted}">· ${x.platform === 'instagram' ? 'Instagram' : 'Facebook'}${i.at ? ` · ${esc(fmt(i.at, { weekday: 'short', day: 'numeric', month: 'short' }))}` : ''}</span>${state}<br>
${did}${i.post ? ` <span style="color:${C.muted}">on “${esc(i.post)}…”</span>` : ''} <a href="${esc(i.postUrl)}" style="color:${C.ink}">${i.kind === 'comment' && x.waiting ? 'Reply' : 'Open post'}</a></td></tr>`;
}

function leadsHtml(l) {
  if (!l.available) return p(`Couldn't read who engaged today: ${esc(l.error || 'Instagram and Facebook are not connected')}.`);
  const table = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows.map(leadRow).join('')}</table>`;
  let html = '';
  if (l.status.instagram === 'permission' && ['permission', 'withheld'].includes(l.status.facebook) && !l.fresh.length && !l.waiting.length) {
    return p(`<b>Not switched on yet.</b> Your posts have comments, but Facebook hasn't given this app permission to see who wrote them, so there are no names to show.`) + small('Fix (one time): in Meta → Crystal Studio app → Facebook Login for Business → Configurations, add <b>instagram_manage_comments</b> and <b>pages_read_user_content</b>, then in the app tap Settings → Reconnect → <b>Edit settings</b> and allow them.');
  }
  html += l.fresh.length ? p(`<b>${l.fresh.length} ${l.fresh.length === 1 ? 'person' : 'people'} engaged in the last 24 hours.</b> Tap a name to open their profile and message them.`) + table(l.fresh.slice(0, 15)) : p('Nobody new has commented or reacted in the last 24 hours.');
  if (l.fresh.length > 15) html += small(`…and ${l.fresh.length - 15} more.`);
  if (l.waiting.length) html += p(`<b>Still waiting for a reply</b> (${l.waiting.length}):`) + table(l.waiting.slice(0, 8));
  const notes = [];
  if (l.status.instagram === 'permission') notes.push('⚠ Instagram hasn’t given this app permission to read comments yet, so Instagram commenters are missing. Fix: add <b>instagram_manage_comments</b> to the app’s Facebook Login setup, then Reconnect.');
  else if (l.status.instagram !== 'ok') notes.push(`⚠ Instagram comments couldn’t be read (${esc(l.status.instagram)}).`);
  if (l.status.facebook === 'permission') notes.push('⚠ Facebook hasn’t given this app permission to read who commented or reacted on the Page. Fix: add <b>pages_read_user_content</b>, then Reconnect.');
  else if (l.status.facebook === 'withheld') notes.push(`Facebook Page: ${l.status.facebookCounted} comment${l.status.facebookCounted === 1 ? '' : 's'} and reactions on recent posts, but Facebook won’t tell this app who they’re from. It only releases names to apps that have passed its App Review, so for now open the post on Facebook to see them.`);
  else if (l.status.facebook !== 'ok') notes.push(`⚠ Facebook engagement couldn’t be read (${esc(l.status.facebook)}).`);
  if (l.status.facebookHidden) notes.push(`${l.status.facebookHidden} Facebook comment${l.status.facebookHidden > 1 ? 's' : ''} had the person’s name hidden by Facebook.`);
  notes.push(`${l.total} ${l.total === 1 ? 'person' : 'people'} on your list from the last 6 months. Instagram never tells any app who <i>liked</i> a post (open the post in Instagram to see them), and neither platform shares phone numbers or emails: the contact is their profile.`);
  return html + notes.map(small).join('');
}

export function headline(r) {
  const high = r.needs.filter((n) => n.level === 'high');
  if (high.length) {
    const conn = r.checks.find((c) => ['instagram', 'facebook'].includes(c.key) && c.ok === false);
    return conn ? 'Instagram and Facebook need reconnecting' : high[0].post ? 'a post is waiting for your OK' : high[0].text.split(':')[0] + ' needs attention';
  }
  const out = r.posts.today.filter((x) => x.status === 'scheduled');
  if (out.length) return `${out.length === 1 ? '1 post goes' : `${out.length} posts go`} out today at ${fmtTime(out[0].scheduledAt)}`;
  const done = r.posts.yesterday.filter((x) => x.status === 'published').length;
  return done ? `${done} post${done > 1 ? 's' : ''} went out yesterday` : 'nothing going out today';
}

export function subject(r) {
  const bad = r.needs.some((n) => n.level === 'high');
  return `${bad ? '⚠' : '✓'} Crystal Cosmetics, ${fmt(r.generatedAt, { weekday: 'short', day: 'numeric', month: 'short' })}: ${headline(r)}`;
}

export function renderEmail(r) {
  const parts = [];
  const okCount = r.checks.filter((c) => c.ok === true).length;
  const badCount = r.checks.filter((c) => c.ok === false).length;

  // Needs you
  if (r.needs.length) {
    parts.push(
      section(
        'Needs you',
        r.needs
          .map((n) => `<div style="border-left:3px solid ${n.level === 'high' ? C.bad : C.gold};padding:2px 0 6px 12px;margin:10px 0">${p(esc(n.text))}${n.post ? postRow(n.post) : ''}${n.links.map(btn).join('')}</div>`)
          .join('')
      )
    );
  }

  // People to reach out to
  if (r.leads) parts.push(section('People to reach out to', leadsHtml(r.leads)));

  // Posts
  let posts = '';
  const y = r.posts.yesterday;
  posts += p(`<b>Yesterday:</b> ${y.length ? '' : 'nothing was posted.'}`);
  posts += y.map((x) => postRow(x)).join('');
  const t = r.posts.today.filter((x) => x.status === 'scheduled' && !x.hold);
  const tDone = r.posts.today.filter((x) => ['published', 'partial', 'publishing'].includes(x.status));
  posts += p(`<b>Today:</b> ${t.length || tDone.length ? '' : r.posts.todayIsPostingDay && r.posts.autopilot ? 'a posting day, but nothing has been lined up (see below).' : 'nothing scheduled.'}`);
  posts += t
    .map((x) => postRow(x, x.auto || x.fromBank ? `<br>${x.auto ? `<a href="${esc(actionLink('swap', x.id))}" style="color:${C.ink}">Pick a different one</a> · ` : ''}<a href="${esc(actionLink('skip', x.id))}" style="color:${C.ink}">Don't post today</a>` : ''))
    .join('');
  posts += tDone.map((x) => postRow(x)).join('');
  if (r.posts.upcoming.length) posts += p(`<b>Next 7 days:</b> ${r.posts.upcoming.length} scheduled`) + r.posts.upcoming.slice(0, 4).map((x) => postRow(x)).join('');
  const n = r.posts.next;
  if (n.slot && dayKey(n.slot) !== r.day && n.fill) {
    const when = `${fmtDay(n.slot)} at ${fmtTime(n.slot)}`;
    const f = n.fill;
    const line =
      f.kind === 'booked' ? `already has a post lined up.`
      : f.kind === 'bank' ? `will use the next post from your content bank.`
      : f.kind === 'repost' ? `has nothing new, so Autopilot will re-share this past top post (${num(f.candidate.stats.reach)} reached, ${num(f.candidate.stats.saved)} saves): “${esc(f.candidate.caption.slice(0, 90))}…”. Add a post to your bank before then to use that instead.`
      : f.kind === 'skipped' ? `was skipped by you.`
      : f.kind === 'off' ? `is empty and Autopilot is switched off.`
      : f.kind === 'nothing' ? `is empty, and no past post is suitable to re-share. Please add a post.`
      : f.kind === 'empty' ? `is empty (re-sharing past posts is switched off).`
      : `couldn't be checked (${esc(f.error || '')}).`;
    posts += p(`<b>Next posting day,</b> ${esc(when)}, ${line}`);
  }
  posts += small(`Content bank: <b>${r.posts.bank}</b> post${r.posts.bank === 1 ? '' : 's'} waiting · Autopilot is <b>${r.posts.autopilot ? 'on' : 'off'}</b> · <a href="${esc(r.app)}/#autopilot" style="color:${C.muted}">Open Autopilot</a>`);
  parts.push(section('Posts', posts));

  // Instagram
  if (r.ig) {
    const g = r.ig;
    const rows = [head(['', 'Yesterday', 'Last 7 days', 'vs week before'])];
    for (const [m, label] of IG_METRICS) if (m in g.week || m in g.yesterday) rows.push([label, num(g.yesterday[m]), num(g.week[m]), change(g.week[m], g.prevWeek[m])]);
    let html = p(`<b>${num(g.followers)}</b> followers${g.followersChange != null ? ` (${signed(g.followersChange)} since yesterday)` : ''}${r.fb?.followers != null ? ` · Facebook Page: <b>${num(r.fb.followers)}</b>${r.fb.followersChange != null ? ` (${signed(r.fb.followersChange)})` : ''}` : ''}`);
    html += rows.length > 1 ? statTable(rows) : small('Instagram has no numbers for this period yet.');
    if (g.newComments) html += p(`💬 <b>${g.newComments} new comment${g.newComments > 1 ? 's' : ''}</b> since yesterday. Replying within a day keeps people (and Instagram) interested. <a href="https://www.instagram.com/${esc(g.username)}/" style="color:${C.ink}">Open Instagram</a>`);
    if (g.top) html += p(`<b>Best post this week:</b> ${TYPE[g.top.type]}, ${num(g.top.stats.reach)} reached, ${num(g.top.stats.saved)} saves, ${num(g.top.stats.shares)} shares. <a href="${esc(g.top.permalink)}" style="color:${C.ink}">View</a>`);
    else if (g.lastPostAt) html += small(`Nothing new on Instagram in the last 7 days. Last post: ${esc(fmt(g.lastPostAt, { day: 'numeric', month: 'short', year: 'numeric' }))}.`);
    parts.push(section(`Instagram @${g.username}`, html));
  }

  // Website
  if (r.web) {
    const w = r.web;
    let html;
    if (!w.tracking) html = p('Website tracking was only just switched on. Visitor and booking-tap numbers will appear here from tomorrow.');
    else {
      const rate = (x) => (x.visits ? `${Math.round((x.book / x.visits) * 100)}%` : '–');
      html = statTable([
        head(['', 'Yesterday', 'Last 7 days', 'vs week before']),
        ['Visits', num(w.yesterday.visits), num(w.week.visits), change(w.week.visits, w.prevWeek.visits)],
        ['Taps on “Book”', num(w.yesterday.book), num(w.week.book), change(w.week.book, w.prevWeek.book)],
        ['Visits that tapped Book', rate(w.yesterday), rate(w.week), ''],
        ['Taps to call', num(w.yesterday.call), num(w.week.call), ''],
        ['Enquiry forms sent', num(w.yesterday.form), num(w.week.form), ''],
      ]);
      if (w.week.sources.length) html += p('<b>Where visitors came from (7 days)</b>') + statTable([head(['', 'Visits', 'Tapped Book']), ...w.week.sources.slice(0, 7).map((s) => [esc(s.label), num(s.visits), num(s.book)])]);
      html += small('“Taps on Book” counts people who pressed a booking button and were sent to Timely. Timely doesn’t share confirmed bookings automatically, so check Timely for the final count.');
    }
    parts.push(section('Website → bookings', html));

    // Ads (worked out from ad clicks that reach the website)
    let ads;
    if (!w.tracking) ads = p('Ad clicks are counted from website visits, which start showing tomorrow.');
    else {
      ads = statTable([head(['', 'Yesterday', 'Last 7 days']), ['Visitors from Google Ads', num(w.yesterday.googleAdsVisits), num(w.week.googleAdsVisits)], ['Visitors from paid social ads', num(w.yesterday.paidVisits - w.yesterday.googleAdsVisits), num(w.week.paidVisits - w.week.googleAdsVisits)]]);
      if (w.week.visits >= 10 && w.week.googleAdsVisits === 0) ads += p(`⚠ No visitors have arrived from Google Ads in the last 7 days. If you are paying for Google Ads, check they are actually running.`, `color:${C.warn}`);
    }
    ads += small('This shows whether paid ads are sending people to the website. Spend and ad status live in Google Ads and Meta Ads Manager, which are not connected to this report.');
    parts.push(section('Ads', ads));
  }

  // Connections
  const mark = (c) => (c.ok === true ? `<span style="color:${C.ok}">✓</span>` : c.ok === false ? `<span style="color:${C.bad}">✗</span>` : `<span style="color:${C.muted}">–</span>`);
  parts.push(section('Connection check', statTable(r.checks.map((c) => [`${mark(c)} ${esc(c.label)}`, `<span style="color:${c.ok === false ? C.bad : C.muted};white-space:normal">${esc(c.note || (c.ok ? 'OK' : ''))}</span>`]))));

  const top = `<tr><td style="background:${C.ink};padding:22px 24px;color:#F5E9D6">
<div style="font-family:Georgia,serif;font-size:24px">Crystal Cosmetics</div>
<div style="font-size:13px;color:${C.gold};letter-spacing:.04em;text-transform:uppercase;margin-top:2px">Morning report · ${esc(fmtDay(r.generatedAt))}</div>
<div style="font-size:16px;margin-top:12px">${badCount ? `⚠ ${badCount} thing${badCount > 1 ? 's need' : ' needs'} attention` : `✓ All ${okCount} checks passed`} · ${esc(headline(r).replace(/^./, (c) => c.toUpperCase()))}</div></td></tr>`;
  const foot = `<tr><td style="padding:20px 24px 26px">${btn({ label: 'Open Marketing Hub', url: r.app })}${small(`Sent automatically by your Marketing Hub at ${esc(fmtTime(r.generatedAt))} Gold Coast time. Change the time, posting days or turn this email off in the app under Autopilot.`)}</td></tr>`;
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject(r))}</title></head>
<body style="margin:0;background:${C.bg};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid ${C.line};border-radius:14px;overflow:hidden">
${top}${parts.join('')}${foot}
</table></td></tr></table></body></html>`;
}

export function renderText(r) {
  const lines = [`Crystal Cosmetics morning report, ${fmtDay(r.generatedAt)}`, headline(r), ''];
  if (r.needs.length) lines.push('NEEDS YOU', ...r.needs.flatMap((n) => [`- ${n.text}`, ...n.links.map((l) => `  ${l.label}: ${l.url}`)]), '');
  lines.push('POSTS', `Yesterday: ${r.posts.yesterday.length || 'none'}`, `Today: ${r.posts.today.filter((x) => x.status === 'scheduled').map((x) => fmtTime(x.scheduledAt)).join(', ') || 'none scheduled'}`, `Content bank: ${r.posts.bank}`, '');
  if (r.leads?.available) lines.push('PEOPLE TO REACH OUT TO', ...(r.leads.fresh.length ? r.leads.fresh.slice(0, 15).map((x) => `- ${x.name} (${x.platform}): ${x.latest.kind === 'comment' ? `"${x.latest.text}"` : 'reacted'} ${x.url}`) : ['Nobody new in the last 24 hours.']), `Waiting for a reply: ${r.leads.waiting.length}`, '');
  if (r.ig) lines.push(`INSTAGRAM @${r.ig.username}`, `Followers: ${num(r.ig.followers)}`, ...IG_METRICS.filter(([m]) => m in r.ig.week).map(([m, l]) => `${l}: ${num(r.ig.yesterday[m])} yesterday, ${num(r.ig.week[m])} in 7 days`), '');
  if (r.web?.tracking) lines.push('WEBSITE', `Visits: ${r.web.yesterday.visits} yesterday, ${r.web.week.visits} in 7 days`, `Taps on Book: ${r.web.yesterday.book} yesterday, ${r.web.week.book} in 7 days`, `From Google Ads: ${r.web.week.googleAdsVisits} in 7 days`, '');
  lines.push('CONNECTIONS', ...r.checks.map((c) => `${c.ok === true ? '[ok]' : c.ok === false ? '[!!]' : '[--]'} ${c.label}${c.note ? `: ${c.note}` : ''}`), '', `Open the app: ${r.app}`);
  return lines.join('\n');
}

// Remember today's numbers so tomorrow's report can show what changed.
export async function saveSnapshot(r) {
  if (r.snap.followers != null && !(await kvGet(`snap:${r.day}`))) await kvSet(`snap:${r.day}`, r.snap, 400 * 86400);
}
