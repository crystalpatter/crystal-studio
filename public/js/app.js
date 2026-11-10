import { check } from './guardrails.js';
import { kindOf, videoType, prepareImage, imageInfo, aiPreview, videoFrame, clampRatio } from './media.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const TZ = 'Australia/Brisbane'; // Gold Coast: UTC+10 all year (no daylight saving)
const TZ_OFFSET_H = 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { status: null, items: [], idea: null, posts: [], month: null, selectedDay: null, busy: false };

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.login) {
    show('login');
    throw new Error('Please log in again.');
  }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

const store = {
  get(k) {
    try {
      return localStorage.getItem('cc:' + k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('cc:' + k, v);
    } catch {
      /* private mode: fine */
    }
  },
};

function fmt(ms, opts = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, ...opts }).format(new Date(ms));
}
function dayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Gold Coast wall-clock parts → timestamp (works even if the phone is set to another time zone)
function gcToMs(y, mo, d, h = 0, mi = 0) {
  return Date.UTC(y, mo, d, h - TZ_OFFSET_H, mi);
}
function gcParts(ms) {
  const d = new Date(ms + TZ_OFFSET_H * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function toLocalInput(ms) {
  const p = gcParts(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo + 1)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}
function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? gcToMs(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

// ---------- routing ----------
const VIEWS = ['login', 'create', 'calendar', 'autopilot', 'insights', 'settings'];
function show(name) {
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
  $('#tabs').hidden = name === 'login';
  $$('#tabs a').forEach((a) => (a.dataset.tab === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (name === 'calendar') loadCalendar();
  if (name === 'autopilot') loadAutopilot();
  if (name === 'insights') loadInsights();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
function route() {
  if (!state.status?.loggedIn) return show('login');
  const tab = location.hash.slice(1);
  show(VIEWS.includes(tab) && tab !== 'login' ? tab : 'create');
}
window.addEventListener('hashchange', route);

// ---------- login ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/status', { method: 'POST', login: true, body: { password: $('#pw').value } });
    $('#pw').value = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/status', { method: 'DELETE' }).catch(() => {});
  state.status = { loggedIn: false };
  show('login');
});

// ---------- create: media ----------
$('#files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const kind = kindOf(file);
    const item = { id: crypto.randomUUID(), file, kind, previewUrl: URL.createObjectURL(file) };
    try {
      if (kind === 'video') {
        const f = await videoFrame(item.previewUrl);
        Object.assign(item, { frame: f, thumbUrl: URL.createObjectURL(f.thumbBlob), duration: f.duration, width: f.width, height: f.height });
      } else {
        const info = await imageInfo(item);
        Object.assign(item, { width: info.width, height: info.height, thumbUrl: item.previewUrl });
      }
      state.items.push(item);
    } catch (err) {
      toast(err.message, 5000);
    }
  }
  if (state.items.length > 10) {
    state.items = state.items.slice(0, 10);
    toast('Instagram carousels hold up to 10. Kept the first 10.');
  }
  renderMedia();
});

function postType() {
  if (!state.items.length) return null;
  if (state.items.length > 1) return 'carousel';
  return state.items[0].kind === 'video' ? 'reel' : 'image';
}

function renderMedia() {
  $('#media-list').innerHTML = state.items
    .map(
      (it, i) => `<div class="thumb"><img src="${it.thumbUrl}" alt="Item ${i + 1}">
      ${it.kind === 'video' ? `<span class="badge">▶ ${Math.round(it.duration || 0)}s</span>` : state.items.length > 1 ? `<span class="badge">${i + 1}</span>` : ''}
      <button class="x" data-remove="${it.id}" aria-label="Remove">×</button></div>`
    )
    .join('');
  const t = postType();
  const notes = [];
  if (t === 'image') notes.push('Photo post');
  if (t === 'carousel') notes.push(`Carousel of ${state.items.length}. Photos will be cropped to the first photo's shape.`);
  if (t === 'reel') {
    const it = state.items[0];
    notes.push('Reel');
    if (it.duration < 3) notes.push('⚠ Reels must be at least 3 seconds.');
    if (it.duration > 15 * 60) notes.push('⚠ Reels can be at most 15 minutes.');
    if (it.height && it.width / it.height > 0.6) notes.push('Tip: vertical (9:16) video looks best as a Reel.');
    if (it.file.size > 1024 * 1024 * 1024) notes.push('⚠ This video is over 1 GB, too big for Instagram.');
  }
  if (t === 'image' && state.items[0].width) {
    const r = state.items[0].width / state.items[0].height;
    if (r < 0.8 || r > 1.91) notes.push("It'll be cropped to fit Instagram's shape.");
  }
  $('#media-type').textContent = notes.join(' · ');
}
$('#media-list').addEventListener('click', (e) => {
  const id = e.target.dataset.remove;
  if (!id) return;
  state.items = state.items.filter((i) => i.id !== id);
  renderMedia();
});

// ---------- create: caption ----------
$('#ideas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-idea]');
  if (!b) return;
  state.idea = state.idea === b.dataset.idea ? null : b.dataset.idea;
  $$('#ideas .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.idea === state.idea)));
});

function fullCaption() {
  const cap = $('#caption').value.trim();
  const tags = $('#hashtags').value.trim();
  return tags ? `${cap}\n\n${tags}` : cap;
}

function updateCaptionInfo() {
  const full = fullCaption();
  $('#count').textContent = full.length;
  const tags = full.match(/#[\p{L}\p{N}_]+/gu) || [];
  $('#tagcount').textContent = tags.length;
  const warns = check(full).map((w) => `<li><b>“${esc(w.match)}”</b>: ${esc(w.why)}</li>`);
  if (full.length > 2200) warns.push('<li>Instagram captions can be at most 2,200 characters.</li>');
  if (tags.length > 30) warns.push('<li>Instagram allows at most 30 hashtags.</li>');
  $('#warnings').innerHTML = warns.join('');
  store.set('caption', $('#caption').value);
  store.set('hashtags', $('#hashtags').value);
}
$('#caption').addEventListener('input', updateCaptionInfo);
$('#hashtags').addEventListener('input', updateCaptionInfo);
$('#notes').addEventListener('input', () => store.set('notes', $('#notes').value));

$('#draft-btn').addEventListener('click', async () => {
  const btn = $('#draft-btn');
  const notes = $('#notes').value.trim();
  if (!state.items.length && !notes) return toast('Add a photo or a few notes first.');
  btn.disabled = true;
  $('#draft-status').textContent = 'Looking at your photos and writing…';
  $('#options').innerHTML = '';
  try {
    const images = [];
    for (const it of state.items.slice(0, 4)) {
      if (it.kind === 'video') images.push(await aiPreview(it.frame.canvas, it.frame.width, it.frame.height));
      else {
        const { img, width, height } = await imageInfo(it);
        images.push(await aiPreview(img, width, height));
      }
    }
    const data = await api('/api/caption', { method: 'POST', body: { images, notes, idea: state.idea, type: postType(), facebook: $('#to-fb').checked } });
    $('#draft-status').innerHTML = data.whatISee ? `The AI sees: <i>${esc(data.whatISee)}</i>` : '';
    state.hashtags = data.hashtags.join(' ');
    $('#options').innerHTML = data.options
      .map(
        (o, i) => `<div class="option"><h3>${esc(o.style)}</h3><p>${esc(o.caption)}</p>
        ${o.warnings.length ? `<ul class="warnings">${o.warnings.map((w) => `<li>${esc(w.why)}</li>`).join('')}</ul>` : ''}
        <button class="btn small" data-use="${i}" type="button">Use this one</button></div>`
      )
      .join('');
    state.options = data.options;
  } catch (err) {
    $('#draft-status').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#options').addEventListener('click', (e) => {
  const i = e.target.dataset.use;
  if (i === undefined) return;
  $('#caption').value = state.options[i].caption;
  if (!$('#hashtags').value.trim() || confirm('Replace your hashtags with the suggested ones?')) $('#hashtags').value = state.hashtags || '';
  updateCaptionInfo();
  $('#caption').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Caption added. Edit it however you like.');
});

// ---------- create: when ----------
function renderQuickTimes() {
  const now = Date.now();
  const p = gcParts(now);
  const picks = [];
  const at = (offsetDays, h) => gcToMs(p.y, p.mo, p.d + offsetDays, h, 0);
  if (at(1, 18) > now) picks.push({ label: 'Tomorrow 6pm', ms: at(1, 18) });
  for (const [dow, name] of [
    [1, 'Mon'],
    [3, 'Wed'],
    [5, 'Fri'],
  ]) {
    let add = (dow - p.dow + 7) % 7;
    if (add === 0 && at(0, 18) < now + 3600000) add = 7;
    const ms = at(add, 18);
    const i = picks.findIndex((q) => q.ms === ms);
    if (i >= 0) picks.splice(i, 1); // "Tomorrow" is also Mon/Wed/Fri: show it once, by its day name
    picks.push({ label: `${name} ${add === 0 ? 'today' : fmt(ms, { day: 'numeric', month: 'short' })} 6pm`, ms });
  }
  picks.sort((a, b) => a.ms - b.ms);
  $('#quick-times').innerHTML = picks.map((q) => `<button type="button" class="chip" data-ms="${q.ms}">${q.label}</button>`).join('');
}
$('#quick-times').addEventListener('click', (e) => {
  const ms = e.target.dataset.ms;
  if (ms) $('#when-at').value = toLocalInput(Number(ms));
});
$$('input[name=when]').forEach((r) =>
  r.addEventListener('change', () => {
    const later = $('input[name=when]:checked').value === 'later';
    $('#when-later').hidden = !later;
    $('#when-bank').hidden = $('input[name=when]:checked').value !== 'bank';
    $('#review-btn').textContent = 'Review post';
    if (later) renderQuickTimes();
  })
);

// ---------- create: review + publish ----------
function scheduledAt() {
  if ($('input[name=when]:checked').value !== 'later') return null;
  return fromLocalInput($('#when-at').value);
}
function toBank() {
  return $('input[name=when]:checked').value === 'bank';
}

$('#review-btn').addEventListener('click', () => {
  if (!state.items.length) return toast('Add a photo or video first.');
  const caption = fullCaption();
  if (!caption) return toast('Add a caption first (or tap ✨ for ideas).');
  if (caption.length > 2200) return toast('Caption is too long for Instagram (2,200 max).');
  const when = scheduledAt();
  const bank = toBank();
  if ($('input[name=when]:checked').value === 'later' && (!when || when < Date.now() + 120000)) return toast('Pick a time in the future.');
  const t = postType();
  const first = state.items[0];
  $('#sheet-title').textContent = bank ? 'Add this to your content bank?' : when ? 'Schedule this post?' : 'Post this now?';
  $('#sheet-preview').hidden = false;
  $('#sheet-progress').hidden = true;
  $('#sheet-preview').innerHTML = `
    ${t === 'carousel' ? `<div class="strip">${state.items.map((i) => `<img src="${i.thumbUrl}" alt="">`).join('')}</div>` : t === 'reel' ? `<video src="${first.previewUrl}" controls playsinline muted></video>` : `<img src="${first.thumbUrl}" alt="">`}
    <div class="cap">${esc(caption)}</div>
    <p class="where">${t === 'reel' ? 'Reel' : t === 'carousel' ? 'Carousel' : 'Photo'} → Instagram${$('#to-fb').checked ? ' + Facebook' : ''} · ${bank ? 'Autopilot picks the day' : when ? fmt(when) + ' (Gold Coast time)' : 'right now'}</p>
    ${check(caption).length ? '<p class="warnings"><li>Your caption has a brief warning (see under the caption). Post anyway only if you\'re sure.</li></p>' : ''}`;
  $('#sheet-confirm').textContent = bank ? 'Add to bank' : when ? 'Schedule' : 'Post now';
  $('#sheet-confirm').disabled = false;
  $('#sheet-cancel').textContent = 'Back';
  $('#sheet').showModal();
});
$('#sheet-cancel').addEventListener('click', () => {
  if (state.busy) return toast("Still working. It's safe to leave; it'll keep going.");
  $('#sheet').close();
});

function steps(list) {
  $('#sheet-progress').innerHTML = list.map((s) => `<div class="step ${s.state || ''}">${esc(s.label)}${s.bar !== undefined ? `<div class="bar"><i style="width:${s.bar}%"></i></div>` : ''}${s.note ? `<div class="muted small">${esc(s.note)}</div>` : ''}</div>`).join('');
}

async function uploadFile(blob, name, contentType, onProgress) {
  if (state.status.devMedia) {
    const r = await fetch(`/dev/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob, headers: { 'content-type': contentType } });
    onProgress?.(100);
    return (await r.json()).url;
  }
  const { upload } = await import('/vendor/blob-client.js');
  const res = await upload(`posts/${name}`, blob, {
    access: 'public',
    handleUploadUrl: '/api/upload',
    contentType,
    multipart: blob.size > 20 * 1024 * 1024,
    onUploadProgress: (e) => onProgress?.(e.percentage),
  });
  return res.url;
}

$('#sheet-confirm').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  $('#sheet-confirm').disabled = true;
  $('#sheet-preview').hidden = true;
  $('#sheet-progress').hidden = false;
  const when = scheduledAt();
  const bank = toBank();
  const toFb = $('#to-fb').checked;
  const s = [
    { label: 'Preparing photos', state: 'doing' },
    { label: 'Uploading', bar: 0 },
    { label: bank ? 'Adding to your bank' : when ? 'Scheduling' : 'Posting to Instagram' },
    ...(toFb && !when && !bank ? [{ label: 'Posting to Facebook' }] : []),
  ];
  steps(s);
  try {
    const t = postType();
    const ratio = t === 'carousel' ? clampRatio(state.items.find((i) => i.kind === 'image')?.width / state.items.find((i) => i.kind === 'image')?.height || 1) : null;
    const prepared = [];
    for (const it of state.items) {
      if (it.kind === 'image') {
        const out = await prepareImage(it, ratio);
        prepared.push({ kind: 'image', blob: out.blob, type: 'image/jpeg', ext: 'jpg', width: out.width, height: out.height });
      } else {
        prepared.push({ kind: 'video', blob: it.file, type: videoType(it.file), ext: videoType(it.file) === 'video/quicktime' ? 'mov' : 'mp4', width: it.width, height: it.height, thumbBlob: it.frame.thumbBlob });
      }
    }
    s[0].state = 'done';
    s[1].state = 'doing';
    steps(s);
    const total = prepared.reduce((n, p) => n + p.blob.size, 0);
    let doneBytes = 0;
    const media = [];
    const stamp = Date.now();
    for (const [i, p] of prepared.entries()) {
      const url = await uploadFile(p.blob, `${stamp}-${i}.${p.ext}`, p.type, (pct) => {
        s[1].bar = Math.round(((doneBytes + (p.blob.size * pct) / 100) / total) * 100);
        steps(s);
      });
      doneBytes += p.blob.size;
      let thumb = p.kind === 'image' ? url : null;
      if (p.thumbBlob) thumb = await uploadFile(p.thumbBlob, `${stamp}-${i}-thumb.jpg`, 'image/jpeg');
      media.push({ url, kind: p.kind, width: p.width, height: p.height, thumb });
    }
    s[1].state = 'done';
    s[1].bar = 100;
    s[2].state = 'doing';
    if (t !== 'image' && !when && !bank) s[2].note = 'Instagram can take a minute or two to process videos and carousels.';
    steps(s);

    let { post } = await api('/api/posts', { method: 'POST', body: { media, caption: fullCaption(), toFacebook: toFb, scheduledAt: when, bank } });

    if (bank) {
      s[2].state = 'done';
      s[2].label = 'In your content bank. Autopilot will post it on your next free posting day.';
      steps(s);
    } else if (when) {
      s[2].state = 'done';
      s[2].label = `Scheduled for ${fmt(post.scheduledAt)}`;
      steps(s);
    } else {
      const started = Date.now();
      while (post.status === 'publishing' && Date.now() - started < 12 * 60000) {
        renderPublishSteps(s, post);
        await new Promise((r) => setTimeout(r, 4000));
        post = (await api(`/api/post?id=${post.id}`, { method: 'POST' })).post;
      }
      renderPublishSteps(s, post);
    }
    finishSheet(post);
  } catch (err) {
    const cur = s.find((x) => x.state === 'doing') || s[s.length - 1];
    cur.state = 'bad';
    cur.note = err.message;
    steps(s);
    $('#sheet-cancel').textContent = 'Close';
  } finally {
    state.busy = false;
  }
});

function renderPublishSteps(s, post) {
  const ig = s[2];
  ig.state = post.ig.status === 'done' ? 'done' : post.ig.status === 'failed' ? 'bad' : 'doing';
  ig.note = post.ig.error ? post.ig.error : ig.state === 'done' ? '' : ig.note;
  if (s[3]) {
    s[3].state = post.fb.status === 'done' ? 'done' : post.fb.status === 'failed' ? 'bad' : post.ig.status === 'done' ? 'doing' : '';
    s[3].note = post.fb.error || '';
  }
  steps(s);
}

function finishSheet(post) {
  const ok = ['published', 'scheduled', 'banked'].includes(post.status);
  $('#sheet-title').textContent = post.status === 'banked' ? 'Added to your bank ✓' : post.status === 'published' ? 'Posted ✓' : post.status === 'scheduled' ? 'Scheduled ✓' : post.status === 'partial' ? 'Posted to Instagram (Facebook failed)' : post.status === 'publishing' ? 'Still processing…' : "Didn't post";
  const links = [];
  if (post.ig.permalink) links.push(`<a class="btn small" href="${esc(post.ig.permalink)}" target="_blank" rel="noopener">View on Instagram</a>`);
  if (post.status === 'publishing') links.push('<p class="small">You can close this. It will finish in the background and show in the Calendar.</p>');
  if (['failed', 'partial'].includes(post.status)) links.push('<p class="small">You can retry from the Calendar tab.</p>');
  $('#sheet-progress').insertAdjacentHTML('beforeend', `<div class="actions" style="margin-top:.6rem">${links.join(' ')}</div>`);
  $('#sheet-cancel').textContent = 'Close';
  $('#sheet-confirm').textContent = 'Start a new post';
  $('#sheet-confirm').disabled = false;
  $('#sheet-confirm').onclick = () => {
    resetCreate();
    $('#sheet').close();
    $('#sheet-confirm').onclick = null;
  };
  if (ok) {
    store.set('caption', '');
    store.set('hashtags', '');
    store.set('notes', '');
  }
}

function resetCreate() {
  state.items = [];
  state.options = [];
  renderMedia();
  $('#caption').value = '';
  $('#hashtags').value = '';
  $('#notes').value = '';
  $('#options').innerHTML = '';
  $('#draft-status').textContent = '';
  updateCaptionInfo();
}

// ---------- calendar ----------
async function loadCalendar() {
  if (!state.month) {
    const p = gcParts(Date.now());
    state.month = { y: p.y, mo: p.mo };
  }
  renderCalendar();
  try {
    const { y, mo } = state.month;
    const from = gcToMs(y, mo - 1, 1);
    const to = gcToMs(y, mo + 2, 1);
    state.posts = (await api(`/api/posts?from=${from}&to=${to}`)).posts;
    renderCalendar();
  } catch (err) {
    $('#post-list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
function postTime(p) {
  return p.publishedAt || p.scheduledAt || p.createdAt;
}
function renderCalendar() {
  const { y, mo } = state.month;
  $('#cal-title').textContent = fmt(gcToMs(y, mo, 15), { month: 'long', year: 'numeric' });
  const first = gcToMs(y, mo, 1);
  const startDow = (gcParts(first).dow + 6) % 7; // Monday first
  const byDay = {};
  for (const p of state.posts) (byDay[dayKey(postTime(p))] ||= []).push(p);
  const today = dayKey(Date.now());
  let html = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const ms = gcToMs(y, mo, 1 - startDow + i, 12);
    const p = gcParts(ms);
    const key = dayKey(ms);
    const posts = byDay[key] || [];
    const sugg = [1, 3, 5].includes(p.dow) && key >= today && !posts.length;
    html += `<button class="cal-day ${p.mo !== mo ? 'other' : ''} ${key === today ? 'today' : ''} ${sugg ? 'sugg' : ''} ${state.selectedDay === key ? 'sel' : ''}" data-day="${key}" aria-label="${fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' })}, ${posts.length} posts">
      <span>${p.d}</span><span class="dots">${posts.map((x) => `<i class="dot ${x.status}"></i>`).join('')}</span></button>`;
    if (i >= 34 && gcParts(gcToMs(y, mo, 1 - startDow + i + 1, 12)).mo !== mo && (i + 1) % 7 === 0) break;
  }
  $('#cal-grid').innerHTML = html;
  renderList();
}
function renderList() {
  let posts = [...state.posts].sort((a, b) => postTime(b) - postTime(a));
  if (state.selectedDay) {
    posts = posts.filter((p) => dayKey(postTime(p)) === state.selectedDay);
    $('#list-title').textContent = fmt(gcToMs(...state.selectedDay.split('-').map((n, i) => (i === 1 ? n - 1 : +n)), 12), { weekday: 'long', day: 'numeric', month: 'long' });
  } else $('#list-title').textContent = 'Upcoming and recent';
  const upcoming = posts.filter((p) => p.status === 'scheduled').reverse();
  const rest = posts.filter((p) => p.status !== 'scheduled');
  const list = [...upcoming, ...rest];
  $('#post-list').innerHTML = list.length
    ? list.map(postCard).join('')
    : `<p class="muted">${state.selectedDay ? 'Nothing on this day.' : 'No posts yet.'} <a href="#create">Create one</a>. The brief suggests Mon/Wed/Fri: healed result, education, behind the scenes.</p>`;
}
const STATUS_LABEL = { scheduled: 'Scheduled', publishing: 'Posting…', published: 'Posted', failed: 'Failed', partial: 'Facebook failed' };
function postCard(p) {
  const thumb = p.media.find((m) => m.thumb)?.thumb;
  const err = p.ig.error || p.fb.error;
  return `<article class="post" data-id="${p.id}">
    ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
    <div>
      <div class="meta"><span class="pill ${p.status}">${p.hold && p.status === 'scheduled' ? 'Waiting for your OK' : STATUS_LABEL[p.status] || p.status}</span>${p.auto ? ' <span class="pill">Re-share</span>' : p.fromBank ? ' <span class="pill">From bank</span>' : ''} ${fmt(postTime(p))} · ${p.type === 'reel' ? 'Reel' : p.type === 'carousel' ? 'Carousel' : 'Photo'}${p.toFacebook ? ' · IG + FB' : ' · IG'}</div>
      <p class="cap">${esc(p.caption)}</p>
      ${err && p.status !== 'published' ? `<p class="err">${esc(err)}</p>` : ''}
      <div class="actions">
        ${p.ig.permalink ? `<a class="btn small ghost" href="${esc(p.ig.permalink)}" target="_blank" rel="noopener">View</a>` : ''}
        ${p.status === 'scheduled' ? `<button class="btn small ghost" data-act="now">Post now</button><button class="btn small ghost" data-act="time">Change time</button><button class="btn small danger" data-act="delete">Cancel</button>` : ''}
        ${['failed', 'partial'].includes(p.status) ? `<button class="btn small" data-act="retry">Retry</button><button class="btn small danger" data-act="delete">Remove</button>` : ''}
        ${p.status === 'publishing' ? `<button class="btn small ghost" data-act="check">Check progress</button>` : ''}
      </div>
    </div></article>`;
}
$('#cal-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  state.selectedDay = state.selectedDay === b.dataset.day ? null : b.dataset.day;
  renderCalendar();
});
$('#cal-prev').addEventListener('click', () => {
  state.month.mo -= 1;
  if (state.month.mo < 0) Object.assign(state.month, { mo: 11, y: state.month.y - 1 });
  state.selectedDay = null;
  loadCalendar();
});
$('#cal-next').addEventListener('click', () => {
  state.month.mo += 1;
  if (state.month.mo > 11) Object.assign(state.month, { mo: 0, y: state.month.y + 1 });
  state.selectedDay = null;
  loadCalendar();
});
$('#post-list').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const id = e.target.closest('[data-id]').dataset.id;
  const post = state.posts.find((p) => p.id === id);
  e.target.disabled = true;
  try {
    if (act === 'delete') {
      if (!confirm(post.status === 'scheduled' ? 'Cancel this scheduled post?' : 'Remove this from the calendar? (It does not delete anything already on Instagram.)')) return;
      await api(`/api/post?id=${id}`, { method: 'DELETE' });
      toast('Removed.');
    } else if (act === 'retry') {
      toast('Retrying…', 8000);
      const { post: p } = await api(`/api/post?id=${id}`, { method: 'PATCH', body: { action: 'retry' } });
      toast(p.status === 'published' ? 'Posted ✓' : STATUS_LABEL[p.status]);
    } else if (act === 'time') {
      const v = prompt('New date and time (Gold Coast), as YYYY-MM-DD HH:MM', toLocalInput(post.scheduledAt).replace('T', ' '));
      if (!v) return;
      const ms = fromLocalInput(v.trim().replace(' ', 'T'));
      if (!ms) return toast('Use the format 2026-11-20 18:00');
      await api(`/api/post?id=${id}`, { method: 'PATCH', body: { scheduledAt: ms } });
      toast(`Moved to ${fmt(ms)}`);
    } else if (act === 'now') {
      if (!confirm('Post this to Instagram right now?')) return;
      toast('Posting…', 10000);
      const { post: p } = await api(`/api/post?id=${id}`, { method: 'PATCH', body: { action: 'now' } });
      toast(STATUS_LABEL[p.status] || p.status);
    } else if (act === 'check') {
      const { post: p } = await api(`/api/post?id=${id}`, { method: 'POST' });
      toast(STATUS_LABEL[p.status] || p.status);
    }
    await loadCalendar();
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    e.target.disabled = false;
  }
});

// ---------- autopilot ----------
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const timeLabel = (h, m) => `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;

async function loadAutopilot() {
  $('#ap-next').innerHTML = '<p class="muted">Loading…</p>';
  try {
    renderAutopilot(await api('/api/autopilot'));
  } catch (err) {
    $('#ap-next').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function miniPost(p, actions = '') {
  return `<article class="post" data-id="${esc(p.id)}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
    <div><div class="meta">${p.scheduledAt ? fmt(p.scheduledAt) + ' · ' : ''}${p.type === 'reel' ? 'Reel' : p.type === 'carousel' ? 'Carousel' : 'Photo'}${p.auto ? ' · re-share' : ''}</div>
    <p class="cap">${esc(p.caption)}</p>${(p.warnings || []).length ? `<p class="err">⚠ ${esc(p.warnings[0].why)}</p>` : ''}<div class="actions">${actions}</div></div></article>`;
}

function renderAutopilot(d) {
  state.ap = d;
  const c = d.config;
  $('#ap-on').checked = c.autopilot;
  $('#ap-on-label').textContent = c.autopilot ? 'On' : 'Off';
  const n = d.next;
  const when = n.slot ? `<b>${fmt(n.slot)}</b>` : '';
  const f = n.fill;
  let html = '';
  if (!n.slot) html = '<p>No posting days are selected below, so Autopilot has nothing to do.</p>';
  else if (f?.kind === 'booked') {
    const p = f.post;
    const acts = p.status !== 'scheduled' ? '' : `${p.hold ? '<button class="btn small" data-ap="approve">Approve</button>' : ''}${p.auto ? '<button class="btn small ghost" data-ap="swap">Pick another</button>' : ''}${p.auto || p.fromBank ? '<button class="btn small ghost" data-ap="skip">Skip that day</button>' : ''}`;
    html = `<p>Next posting day, ${when}: ${p.status === 'scheduled' ? (p.hold ? 'this re-share is <b>waiting for your OK</b>.' : 'this is lined up.') : 'already posted.'}</p>${miniPost(p, acts)}`;
  } else if (f?.kind === 'bank') html = `<p>Next posting day, ${when}: the next post from your bank will go out.</p>${miniPost(f.post)}`;
  else if (f?.kind === 'repost') {
    const k = f.candidate;
    const st = [typeof k.stats.reach === 'number' ? `${k.stats.reach.toLocaleString('en-AU')} reached` : '', typeof k.stats.saved === 'number' ? `${k.stats.saved} saves` : '', typeof k.stats.likes === 'number' ? `${k.stats.likes} likes` : ''].filter(Boolean).join(' · ');
    html = `<p>Next posting day, ${when}: your bank is empty, so ${c.approval === 'ask' ? 'Autopilot will <b>ask you</b> to approve' : 'Autopilot will re-share'} this past top post${st ? ` (${st})` : ''}. Add a post to your bank to use that instead.</p>
      <article class="post">${k.thumb ? `<img src="${esc(k.thumb)}" alt="" loading="lazy">` : '<div class="ph"></div>'}<div><div class="meta">First posted ${fmt(k.timestamp, { day: 'numeric', month: 'short', year: 'numeric' })}</div><p class="cap">${esc(k.caption)}</p><div class="actions"><a class="btn small ghost" href="${esc(k.permalink)}" target="_blank" rel="noopener">View original</a></div></div></article>`;
  } else if (f?.kind === 'skipped') html = `<p>Next posting day, ${when}: you chose to skip it.</p>`;
  else if (f?.kind === 'off') html = `<p>Autopilot is off. Next posting day would be ${when}.</p>`;
  else if (f?.kind === 'empty') html = `<p>Next posting day, ${when}: your bank is empty and re-sharing is off, so <b>nothing will go out</b>.</p>`;
  else if (f?.kind === 'nothing') html = `<p>Next posting day, ${when}: your bank is empty and no past post is suitable to re-share. <a href="#create">Add a post</a>.</p>`;
  else if (f?.kind === 'error') html = `<p class="error">Couldn't check what's next: ${esc(f.error)}</p>`;
  $('#ap-next').innerHTML = html;

  const weeks = c.days.length ? d.bank.length / c.days.length : 0;
  $('#ap-bank-note').textContent = d.bank.length ? `${d.bank.length} waiting, oldest goes first. That's about ${weeks < 1 ? 'under a week' : Math.round(weeks) + (Math.round(weeks) === 1 ? ' week' : ' weeks')} of posts.` : 'Empty. In Create, choose “Add to bank” instead of a date and it lands here.';
  $('#ap-bank').innerHTML = d.bank.map((p) => miniPost(p, '<button class="btn small danger" data-ap="unbank">Remove</button>')).join('');

  $('#ap-days').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((n) => `<button type="button" class="chip" data-dow="${n}" aria-pressed="${c.days.includes(n)}">${DAY_NAMES[n]}</button>`).join('');
  const times = [];
  for (let h = 6; h <= 21; h++) for (const m of [0, 30]) times.push(`<option value="${h}:${m}" ${h === c.hour && m === c.minute ? 'selected' : ''}>${timeLabel(h, m)}</option>`);
  $('#ap-time').innerHTML = times.join('');
  $('#ap-fallback').checked = c.fallback;
  $('#ap-ask').checked = c.approval === 'ask';
  $('#ap-ask').disabled = !c.fallback;
  $('#ap-fb').checked = c.toFacebook;
  $('#ap-report').checked = c.reportOn;
  if (document.activeElement !== $('#ap-email')) $('#ap-email').value = d.mail.to || '';
  const last = d.lastReport ? `Last report: ${fmt(d.lastReport.at)}.` : '';
  $('#ap-mail-note').innerHTML = !d.mail.configured
    ? '⚠ Emails can’t be sent yet: the email key (RESEND_API_KEY) hasn’t been added in Vercel. The report is still built every morning; tap <b>View today’s report</b> to read it here.'
    : d.mail.lastError
      ? `⚠ ${esc(d.mail.lastError)}`
      : !d.mail.to
        ? 'Add the address the report should go to.'
        : `${esc(last)} Arrives about 8am Gold Coast time, every day.`;
}

async function apSave(patch, msg = 'Saved.') {
  try {
    renderAutopilot(await api('/api/autopilot', { method: 'PATCH', body: patch }));
    toast(msg);
  } catch (err) {
    toast(err.message, 6000);
    loadAutopilot();
  }
}
$('#ap-on').addEventListener('change', (e) => apSave({ autopilot: e.target.checked }, e.target.checked ? 'Autopilot is on.' : 'Autopilot is off. Nothing will post unless you schedule it.'));
$('#ap-days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dow]');
  if (!b) return;
  const n = Number(b.dataset.dow);
  const days = new Set(state.ap.config.days);
  days.has(n) ? days.delete(n) : days.add(n);
  apSave({ days: [...days] });
});
$('#ap-time').addEventListener('change', (e) => {
  const [hour, minute] = e.target.value.split(':').map(Number);
  apSave({ hour, minute });
});
$('#ap-fallback').addEventListener('change', (e) => apSave({ fallback: e.target.checked }));
$('#ap-ask').addEventListener('change', (e) => apSave({ approval: e.target.checked ? 'ask' : 'auto' }));
$('#ap-fb').addEventListener('change', (e) => apSave({ toFacebook: e.target.checked }));
$('#ap-report').addEventListener('change', (e) => apSave({ reportOn: e.target.checked }));
$('#ap-save-email').addEventListener('click', () => apSave({ emailTo: $('#ap-email').value }, 'Address saved.'));
$('#ap-test').addEventListener('click', async (e) => {
  e.target.disabled = true;
  toast('Building your report…', 15000);
  try {
    const r = await api('/api/autopilot', { method: 'POST', body: { action: 'test-report' } });
    toast(r.did === 'sent' ? `Sent to ${r.to}. Check your inbox (and Junk the first time).` : r.did === 'saved-not-sent' ? (r.why === 'no-recipient' ? 'Add and save an email address first.' : 'Email isn’t set up yet (RESEND_API_KEY is missing in Vercel).') : r.error || 'That didn’t send.', 8000);
  } catch (err) {
    toast(err.message, 8000);
  } finally {
    e.target.disabled = false;
    loadAutopilot();
  }
});
async function apAction(e) {
  const act = e.target.dataset.ap;
  if (!act) return;
  const id = e.target.closest('[data-id]').dataset.id;
  const ask = { skip: 'Skip that posting day? Nothing will go out.', swap: 'Drop this one and pick the next best?', unbank: 'Remove this post from your bank? This deletes it from the app.' }[act];
  if (ask && !confirm(ask)) return;
  e.target.disabled = true;
  try {
    const d = await api('/api/autopilot', { method: 'POST', body: { action: act, id } });
    renderAutopilot(d);
    toast({ approve: 'Approved. It will go out on time.', skip: 'Skipped.', swap: d.result.next ? 'Swapped.' : d.result.note, unbank: 'Removed.' }[act], 5000);
  } catch (err) {
    toast(err.message, 6000);
    loadAutopilot();
  }
}
$('#ap-next').addEventListener('click', apAction);
$('#ap-bank').addEventListener('click', apAction);

// ---------- insights ----------
async function loadInsights(fresh = false) {
  if (!state.status?.meta) {
    $('#ins-tiles').innerHTML = '';
    $('#ins-media').innerHTML = '';
    $('#ins-note').innerHTML = 'Connect Instagram first (Settings tab).';
    return;
  }
  $('#ins-note').textContent = 'Loading…';
  try {
    const d = await api(`/api/insights${fresh ? '?fresh=1' : ''}`);
    const tiles = [{ label: 'Followers', value: d.followers }, ...d.totals];
    $('#ins-tiles').innerHTML = tiles
      .filter((t) => typeof t.value === 'number')
      .map((t) => `<div class="tile"><div class="n">${t.value.toLocaleString('en-AU')}</div><div class="l">${esc(t.label)}</div></div>`)
      .join('');
    $('#ins-note').textContent = `@${d.username} · updated ${fmt(d.fetchedAt, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}. Instagram can take up to 48 hours to finish counting.`;
    $('#ins-media').innerHTML = d.media
      .map((m) => {
        const s = m.stats;
        const stat = (n, l) => (typeof n === 'number' ? `<span><b>${n.toLocaleString('en-AU')}</b> ${l}</span>` : '');
        return `<article class="post">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div><div class="meta">${m.type} · ${fmt(Date.parse(m.timestamp), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        <p class="cap">${esc(m.caption)}</p>
        <div class="stats">${stat(s.reach, 'reached')}${stat(s.views, 'views')}${stat(s.saved, 'saves')}${stat(s.shares, 'shares')}${stat(s.likes, 'likes')}${stat(s.comments, 'comments')}</div>
        <div class="actions"><a class="btn small ghost" href="${esc(m.permalink)}" target="_blank" rel="noopener">View</a></div></div></article>`;
      })
      .join('');
  } catch (err) {
    $('#ins-note').textContent = err.message;
  }
}
$('#ins-refresh').addEventListener('click', () => loadInsights(true));

// ---------- settings ----------
function renderSettings() {
  const s = state.status || {};
  const item = (ok, label, help) => `<li class="${ok ? 'ok' : 'no'}">${label}${!ok && help ? `<small>${help}</small>` : ''}</li>`;
  $('#checks').innerHTML = [
    item(s.passwordSet, 'App password'),
    item(s.claude, 'AI captions (Claude)', 'Add ANTHROPIC_API_KEY in Vercel (setup guide, Part 3).'),
    item(s.media || s.devMedia, 'Photo & video storage', 'In Vercel: Storage → Blob → Public (setup guide, Part 3).'),
    item(s.database, 'Post calendar database', 'In Vercel: Storage → Upstash Redis (setup guide, Part 3).'),
    item(s.metaApp && s.metaAppCheck?.ok !== false, 'Meta app', !s.metaApp ? 'Add META_APP_ID and META_APP_SECRET in Vercel (setup guide, Part 3).' : metaAppHint(s.metaAppCheck)),
    item(Boolean(s.meta?.igId), s.meta?.igId ? `Instagram <b>@${esc(s.meta.igUsername)}</b>` : 'Instagram', s.metaError || (s.tokenSet ? 'The Page has no Instagram Business account linked.' : 'Tap Connect below and log in on Facebook.')),
    item(Boolean(s.meta?.pageId), s.meta?.pageName ? `Facebook Page <b>${esc(s.meta.pageName)}</b>` : 'Facebook Page'),
  ].join('');
  $('#connect-btn').textContent = s.meta ? 'Reconnect Instagram & Facebook' : 'Connect Instagram & Facebook';
  $('#connect-btn').classList.toggle('ghost', Boolean(s.meta));
}

function metaAppHint(c) {
  if (!c || c.ok !== false) return '';
  const fix = 'In Meta: Crystal Studio (App ID in Vercel) → App settings → Basic → click Show next to App secret, then copy the 32 letters/numbers and paste them into META_APP_SECRET in Vercel, Save, and redeploy.';
  if (c.shape === 'dots') return `The saved App secret is the hidden dots, not the secret itself. ${fix}`;
  if (c.shape === 'is-app-id') return `The App ID was saved as the secret. ${fix}`;
  if (c.shape.startsWith('not-32')) return `The saved App secret doesn't look like a Meta secret (it should be 32 letters/numbers; this one is ${c.shape.replace('not-32 ', '')}). ${fix}`;
  return `Meta says the App secret doesn't match this App ID. It may be from the other Crystal Studio app. ${fix}`;
}

function renderBanner() {
  const s = state.status;
  const missing = [];
  if (!s.meta?.igId) missing.push('connect Instagram');
  if (!s.claude) missing.push('add the AI key');
  if (!(s.media || s.devMedia)) missing.push('add photo storage');
  $('#setup-banner').hidden = !missing.length;
  $('#setup-banner').innerHTML = `Almost set up: ${missing.join(', ')}. <a href="#settings">Open Settings</a>`;
  $('#acct').textContent = s.meta?.igUsername ? `@${s.meta.igUsername}` : '';
  if (s.meta?.igUsername) $('#ig-handle').textContent = `@${s.meta.igUsername}`;
}

// ---------- start ----------
async function boot() {
  try {
    state.status = await api('/api/status');
  } catch {
    state.status = { loggedIn: false };
  }
  if (state.status.loggedIn) {
    renderBanner();
    $('#caption').value = store.get('caption') || '';
    $('#hashtags').value = store.get('hashtags') || '';
    $('#notes').value = store.get('notes') || '';
    updateCaptionInfo();
    if (state.status.meta) api('/api/autopilot', { method: 'POST', body: { action: 'run' } }).catch(() => {});
  }
  route();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
