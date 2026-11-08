// Simple single-user login. Crystal picks a password and saves it in Vercel as
// APP_PASSWORD. Logging in sets a signed cookie that lasts 180 days, so the
// home-screen app stays logged in. Changing APP_PASSWORD logs every device out.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'cc_session';
const MAX_AGE = 180 * 24 * 3600;

function key() {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  return createHmac('sha256', 'crystal-studio-session').update(pw).digest();
}

export function sign(value) {
  const k = key();
  if (!k) throw new Error('APP_PASSWORD is not set');
  return createHmac('sha256', k).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function passwordMatches(input) {
  const pw = process.env.APP_PASSWORD;
  if (!pw || typeof input !== 'string') return false;
  // Compare hashes so the comparison is constant-time whatever the lengths.
  const h = (s) => createHmac('sha256', 'pw').update(s).digest('hex');
  return safeEqual(h(input), h(pw));
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie() {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const value = `${exp}.${sign(String(exp))}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function isLoggedIn(request) {
  if (!key()) return false;
  const raw = readCookie(request, COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

export function randomToken() {
  return randomBytes(18).toString('base64url');
}
