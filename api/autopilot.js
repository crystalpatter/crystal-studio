// Autopilot screen: settings, the content bank, what's lined up next, and the
// morning report (view it, or send a test copy). Also the "app just opened,
// publish anything overdue" nudge. One file because Vercel's free plan allows
// at most 12 functions per project.
import { authed, json, fail, body, query } from '../lib/http.js';
import { runDue } from '../lib/publisher.js';
import { buildReport, renderEmail } from '../lib/report.js';
import { sendDaily } from '../lib/daily.js';
import { getConfig, saveConfig, reportRecipient } from '../lib/config.js';
import { bankList, kvGet } from '../lib/store.js';
import { preview, brief, plan, approve, skip, swap, unbank } from '../lib/autopilot.js';
import { mailConfigured, mailFrom } from '../lib/mail.js';

async function state() {
  const config = await getConfig();
  const [next, bank, latest, error, hb] = await Promise.all([preview(), bankList(), kvGet('report-latest'), kvGet('report-error'), kvGet('heartbeat')]);
  return {
    config,
    next,
    bank: bank.map(brief),
    mail: { configured: mailConfigured(), to: reportRecipient(config), from: mailConfigured() ? mailFrom() : null, lastError: error?.error || null },
    lastReport: latest ? { day: latest.day, at: latest.at, subject: latest.subject } : null,
    scheduler: hb || null,
  };
}

export const GET = authed(async (request) => {
  if (query(request).get('view') === 'report') {
    const html = renderEmail(await buildReport());
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return json(await state());
});

export const PATCH = authed(async (request) => {
  await saveConfig(await body(request));
  return json(await state());
});

export const POST = authed(async (request) => {
  const b = await body(request);
  const actions = { approve, skip, swap, unbank };
  let result;
  if (b.action === 'run') {
    // The app pings this when it opens, so overdue posts go out even if the scheduler is late.
    const results = await runDue({ totalMs: 20000 });
    return json({ results, autopilot: (await plan().catch(() => ({ did: 'error' }))).did });
  }
  if (b.action === 'test-report') return json(await sendDaily(Date.now(), { force: true }));
  if (b.action === 'plan') result = await plan();
  else if (actions[b.action] && typeof b.id === 'string') result = await actions[b.action](b.id);
  else return fail('Unknown action.');
  return json({ result, ...(await state()) });
});
