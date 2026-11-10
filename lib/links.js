// One-tap links for the morning email (Approve / Skip / Swap). Each link is
// signed with a key made from the app password, names one action on one post,
// and stops working after 3 days. Tapping it opens a confirm page first, so
// email scanners that "click" links can't trigger anything.
import { sign } from './auth.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `http://localhost:${process.env.PORT || 5180}`;
}

export function actionToken(action, id, ttlMs = 3 * 86400000) {
  const payload = b64(JSON.stringify({ a: action, id, exp: Date.now() + ttlMs }));
  return `${payload}.${sign(`act:${payload}`)}`;
}

export function actionLink(action, id) {
  return `${appUrl()}/api/act?t=${actionToken(action, id)}`;
}

export function readActionToken(t) {
  const [payload, sig] = String(t || '').split('.');
  if (!payload || !sig) return null;
  let expected;
  try {
    expected = sign(`act:${payload}`);
  } catch {
    return null;
  }
  if (sig.length !== expected.length || !Buffer.from(sig).equals(Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!['approve', 'skip', 'swap'].includes(d.a) || typeof d.id !== 'string' || d.exp < Date.now()) return null;
    return d;
  } catch {
    return null;
  }
}
