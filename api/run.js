// The app pings this when it opens, so overdue scheduled posts go out even
// if the background scheduler is late.
import { authed, json } from '../lib/http.js';
import { runDue } from '../lib/publisher.js';

export const POST = authed(async () => json({ results: await runDue({ totalMs: 20000 }) }));
