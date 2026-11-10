// Morning report trigger (also run from /api/cron). Sends at most once a day.
import { json, fail } from '../lib/http.js';
import { sendDaily } from '../lib/daily.js';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) return fail('Not allowed', 401);
  try {
    const r = await sendDaily();
    return json({ ok: true, did: r.did });
  } catch (err) {
    console.error(err);
    return fail(err.userMessage || err.message, 500);
  }
}
export const POST = GET;
