// The brief's "Never" list, as checks. Used in the browser (live warnings while
// Crystal edits a caption) and on the server (on every AI draft).
// Each rule: a pattern and the plain-English reason it's flagged.
export const RULES = [
  { re: /\b\d+\s*\+\s*(years?|yrs?)\b/i, why: 'Mentions years of experience. The brief says not to claim this.' },
  { re: /\b(years?|decades?) (of experience|in the (industry|business))\b/i, why: 'Mentions years of experience. The brief says not to claim this.' },
  { re: /\b\d[\d,]*\s*\+?\s*(happy |satisfied )?(clients|customers|brows|lips)\b/i, why: 'Gives a client count. The brief says not to claim this.' },
  { re: /(\b[1-5](\.\d)?\s*[- ]?stars?\b|★|⭐)/i, why: 'Mentions a star rating. The brief says not to claim this.' },
  { re: /\b(best|leading|number one|no\.?\s?1|#1|most trusted|premier|finest|top[- ]rated)\b/i, why: '"Best / leading / most trusted"-type claim. The brief says not to use these.' },
  { re: /\bcertifi(ed|cate|cation)\b/i, why: 'Says "certified". The brief says the course must not be described as certifying anyone.' },
  { re: /\b(painless|pain[- ]free|no pain|doesn'?t hurt|won'?t hurt|guarantee[ds]?)\b/i, why: 'A "painless" or guarantee-type promise. The brief says not to make these.' },
  { re: /\b(collagen induction|microneedling|micro-needling|lash extensions?|eyeliner tattoo|eyeliner)\b/i, why: 'Mentions a service Crystal does not offer.' },
  { re: /\b(hair[- ]?strokes?|microblad\w*)\b/i, why: 'Hair strokes / microblading. Powder brows are shading, not hair strokes, and microblading is not offered.' },
];

export function check(text = '') {
  const found = [];
  for (const r of RULES) {
    const m = String(text).match(r.re);
    if (m && !found.some((f) => f.why === r.why)) found.push({ match: m[0], why: r.why });
  }
  return found;
}
