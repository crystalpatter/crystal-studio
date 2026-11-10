// Gold Coast time. Queensland is UTC+10 all year (no daylight saving), so
// plain arithmetic is exact.
export const TZ = 'Australia/Brisbane';
export const TZ_H = 10;
export const HOUR = 3600000;
export const DAY = 86400000;

export function parts(ms) {
  const d = new Date(ms + TZ_H * HOUR);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
export function at(y, mo, d, h = 0, mi = 0) {
  return Date.UTC(y, mo, d, h - TZ_H, mi);
}
export function dayStart(ms) {
  const p = parts(ms);
  return at(p.y, p.mo, p.d);
}
export function dayKey(ms) {
  const p = parts(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo + 1)}-${z(p.d)}`;
}
export function fmt(ms, opts = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, ...opts }).format(new Date(ms));
}
export const fmtDay = (ms) => fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtTime = (ms) => fmt(ms, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
