// Autopilot screen: settings, the content bank, and what's lined up next.
import { authed, json, fail, body } from '../lib/http.js';
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

export const GET = authed(async () => json(await state()));

export const PATCH = authed(async (request) => {
  await saveConfig(await body(request));
  return json(await state());
});

export const POST = authed(async (request) => {
  const b = await body(request);
  const actions = { approve, skip, swap, unbank };
  let result;
  if (b.action === 'plan') result = await plan();
  else if (actions[b.action] && typeof b.id === 'string') result = await actions[b.action](b.id);
  else return fail('Unknown action.');
  return json({ result, ...(await state()) });
});
