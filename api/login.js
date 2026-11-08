import { passwordMatches, sessionCookie, clearCookie } from '../lib/auth.js';
import { json, fail, body } from '../lib/http.js';

export async function POST(request) {
  if (!process.env.APP_PASSWORD) return fail('APP_PASSWORD has not been set in Vercel yet.', 503);
  const { password } = await body(request);
  if (!passwordMatches(password)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return fail('That password is not right.', 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie() });
}

export async function DELETE() {
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
