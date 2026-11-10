// The scheduler. Vercel calls this once an hour and GitHub calls it as a
// backup (the app also nudges it whenever Crystal opens it). Each call:
//   1. publishes any post whose time has come,
//   2. lets Autopilot fill today's posting slot if it's still empty,
//   3. sends the morning report if it's due and hasn't gone yet (built in the
//      7am hour and held until 8:00; the 8am run is the backup).
// Safe to call any time, as often as you like.
import { json, fail } from '../lib/http.js';
import { runDue } from '../lib/publisher.js';
import { plan } from '../lib/autopilot.js';
import { kvSet } from '../lib/store.js';
import { sendDaily } from '../lib/daily.js';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) return fail('Not allowed', 401);
  const started = Date.now();
  const left = () => 55000 - (Date.now() - started);
  try {
    const by = /vercel-cron/i.test(request.headers.get('user-agent') || '') ? 'vercel' : 'other';
    await kvSet('heartbeat', { at: started, by }).catch(() => {});
    const results = await runDue({ totalMs: 30000 });
    const out = { ok: true, ran: results.length, results };
    if (left() > 22000) out.autopilot = (await plan().catch((err) => ({ did: 'error', error: err.message }))).did;
    if (left() > 20000) out.report = (await sendDaily().catch((err) => ({ did: 'error', error: err.message }))).did;
    return json(out);
  } catch (err) {
    console.error(err);
    return fail(err.userMessage || err.message, 500);
  }
}
export const POST = GET;
