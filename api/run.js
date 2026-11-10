// The app pings this when it opens, so overdue scheduled posts go out even
// if the background scheduler is late.
import { authed, json } from '../lib/http.js';
import { runDue } from '../lib/publisher.js';
import { plan } from '../lib/autopilot.js';

export const POST = authed(async () => {
  const results = await runDue({ totalMs: 20000 });
  const autopilot = (await plan().catch(() => ({ did: 'error' }))).did;
  return json({ results, autopilot });
});
