// The morning report, for Crystal: view it now (GET, opens as a page) or send
// a test copy to her inbox (POST).
import { authed, json } from '../lib/http.js';
import { buildReport, renderEmail } from '../lib/report.js';
import { sendDaily } from '../lib/daily.js';

export const GET = authed(async () => {
  const html = renderEmail(await buildReport());
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
});

export const POST = authed(async () => json(await sendDaily(Date.now(), { force: true })));
