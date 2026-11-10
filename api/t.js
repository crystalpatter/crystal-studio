// Anonymous visit counter for the website (www.crystalcosmetics.com.au).
// The site's js/main.js sends { e: 'pv' | 'book' | 'call' | 'form', s: source,
// p: path, n: 1 if first page of the visit }. We only add 1 to today's
// counters; nothing about the visitor is stored.
import { record } from '../lib/web.js';

const SITES = ['https://www.crystalcosmetics.com.au', 'https://crystalcosmetics.com.au'];

function cors(request) {
  const origin = request.headers.get('origin') || '';
  const ok = SITES.includes(origin) || (!process.env.VERCEL && /^http:\/\/localhost(:\d+)?$/.test(origin));
  return { ok, headers: { 'access-control-allow-origin': ok ? origin : SITES[0], 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin', 'cache-control': 'no-store' } };
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: cors(request).headers });
}

export async function POST(request) {
  const { ok, headers } = cors(request);
  if (!ok) return new Response(null, { status: 204, headers });
  if (/bot|crawl|spider|headless|lighthouse|preview|monitor/i.test(request.headers.get('user-agent') || '')) return new Response(null, { status: 204, headers });
  try {
    const text = (await request.text()).slice(0, 500);
    await record(JSON.parse(text));
  } catch {
    /* a bad ping is simply ignored */
  }
  return new Response(null, { status: 204, headers });
}
