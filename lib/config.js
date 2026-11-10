// Autopilot + morning report settings. Saved in the database so Crystal can
// change them from the app's Autopilot tab; nothing here is secret.
import { kvGet, kvSet } from './store.js';

export const DEFAULTS = {
  autopilot: true, // give banked posts a time, and fill empty slots
  days: [1, 3, 5], // posting days: 0 = Sunday … 6 = Saturday (Mon / Wed / Fri)
  hour: 18, // posting time, Gold Coast time
  minute: 0,
  fallback: true, // nothing in the bank → re-share a past top performer
  approval: 'auto', // 'auto' = re-shares go out on their own; 'ask' = wait for a tap on Approve
  toFacebook: true, // re-shares also go to the Facebook Page
  reportOn: true, // morning email
  reportHour: 8,
  emailTo: '', // where the morning email goes (falls back to REPORT_EMAIL_TO in Vercel)
};

export async function getConfig() {
  let saved = null;
  try {
    saved = await kvGet('config');
  } catch {
    /* database not reachable: run on defaults */
  }
  return { ...DEFAULTS, ...(saved || {}) };
}

export function reportRecipient(cfg) {
  return (cfg.emailTo || process.env.REPORT_EMAIL_TO || '').trim();
}

const isEmail = (s) => /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(s);

// Accepts only known keys with sane values; returns the saved settings.
export async function saveConfig(patch = {}) {
  const cur = await getConfig();
  const next = { ...cur };
  for (const k of ['autopilot', 'fallback', 'toFacebook', 'reportOn']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  if (Array.isArray(patch.days)) next.days = [...new Set(patch.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (Number.isInteger(patch.hour) && patch.hour >= 6 && patch.hour <= 21) next.hour = patch.hour;
  if (Number.isInteger(patch.minute) && [0, 15, 30, 45].includes(patch.minute)) next.minute = patch.minute;
  if (['auto', 'ask'].includes(patch.approval)) next.approval = patch.approval;
  if (typeof patch.emailTo === 'string') {
    const e = patch.emailTo.trim();
    if (e && !isEmail(e)) throw Object.assign(new Error("That email address doesn't look right."), { status: 400, userMessage: "That email address doesn't look right." });
    next.emailTo = e;
  }
  await kvSet('config', next);
  return next;
}
