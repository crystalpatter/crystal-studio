// The scheduler. A GitHub Action calls this every 10 minutes (and the app calls
// it whenever Crystal opens it), and it publishes anything that's due.
// Safe to call any time: it only touches posts whose time has come.
import { json, fail } from '../lib/http.js';
import { runDue } from '../lib/publisher.js';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) return fail('Not allowed', 401);
  try {
    const results = await runDue();
    return json({ ok: true, ran: results.length, results });
  } catch (err) {
    console.error(err);
    return fail(err.userMessage || err.message, 500);
  }
}
export const POST = GET;
