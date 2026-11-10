// Sends the morning report once a day.
//
// Vercel's free scheduler fires "some time within the hour", so to land the
// email at 8:00am on the dot we build it during the 7 o'clock hour and ask the
// email service to hold it until 8:00. If that isn't possible it simply goes
// on the first run after 8:00. Either way it can only be sent once per day.
import { getConfig, reportRecipient } from './config.js';
import { kvGet, kvSet, kvOnce, kvDel } from './store.js';
import { buildReport, renderEmail, renderText, subject, saveSnapshot } from './report.js';
import { sendMail, mailConfigured } from './mail.js';
import { plan } from './autopilot.js';
import { parts, at, dayKey } from './time.js';

export async function sendDaily(now = Date.now(), { force = false } = {}) {
  const cfg = await getConfig();
  const p = parts(now);
  const day = dayKey(now);
  const due = at(p.y, p.mo, p.d, cfg.reportHour, 0);
  if (!force) {
    if (!cfg.reportOn) return { did: 'off' };
    if (now < due - 3600000 || p.h >= 23) return { did: 'not-yet' };
    if (await kvGet(`report-done:${day}`)) return { did: 'already' };
    const early = now < due - 60000;
    if (early && (await kvGet('mail-no-scheduling'))) return { did: 'waiting-for-8' };
    if (!(await kvOnce(`report-lock:${day}`, 1, 120))) return { did: 'busy' };
  }
  try {
    if (!force) await plan(now).catch(() => {}); // make sure today's slot is filled before we describe it
    const report = await buildReport(now);
    const html = renderEmail(report);
    await saveSnapshot(report);
    await kvSet('report-latest', { day, at: now, subject: subject(report), html }, 14 * 86400);

    const to = reportRecipient(cfg);
    if (!mailConfigured() || !to) {
      // Nothing to send with yet: the report is still saved for the app to show.
      if (!force) await kvSet(`report-done:${day}`, { at: now, sent: false, why: !to ? 'no-recipient' : 'not-configured' }, 3 * 86400);
      return { did: 'saved-not-sent', why: !to ? 'no-recipient' : 'not-configured', subject: subject(report) };
    }
    const early = !force && now < due - 60000;
    let res = await sendMail({ to, subject: subject(report), html, text: renderText(report), sendAt: early ? due : null });
    if (!res.ok && res.reason === 'no-scheduling') {
      await kvSet('mail-no-scheduling', 1, 30 * 86400);
      return { did: 'waiting-for-8' };
    }
    if (!res.ok) {
      await kvSet('report-error', { at: now, error: res.error, reason: res.reason }, 7 * 86400);
      // Try again on the next run, but stop after a few goes so we never spam.
      const tries = ((await kvGet(`report-tries:${day}`)) || 0) + 1;
      await kvSet(`report-tries:${day}`, tries, 2 * 86400);
      if (tries >= 4 && !force) await kvSet(`report-done:${day}`, { at: now, sent: false, why: res.reason }, 3 * 86400);
      return { did: 'failed', error: res.error };
    }
    await kvDel('report-error');
    if (!force) await kvSet(`report-done:${day}`, { at: now, sent: true, id: res.id, scheduled: res.scheduled }, 3 * 86400);
    return { did: res.scheduled ? 'scheduled-for-8' : 'sent', to, subject: subject(report) };
  } finally {
    if (!force) await kvDel(`report-lock:${day}`);
  }
}
