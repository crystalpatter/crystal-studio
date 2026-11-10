// Fills the local dev app with pretend data so the Autopilot screen and the
// morning email can be looked at without any real accounts.
//   node dev/preview-data.js   (then: npm run dev)
import fs from 'node:fs';
import { startMockGraph } from './mock-graph.js';

const DAY = 86400000;
const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
const img = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#C08B7A"/></svg>');
export const MEDIA = [
  { id: 'OLD1', caption: 'Healed lip blush, soft and rosy. This is six weeks on and exactly the shade she asked for.\n\nDM "LIPS" to book.', media_type: 'IMAGE', timestamp: iso(200), permalink: 'https://www.instagram.com/p/OLD1/', media_url: img, like_count: 54, comments_count: 6 },
  { id: 'OLD2', caption: 'Powder brows, one week healed. Soft shading that looks like brow powder that stays.\n\nBook via the link in bio.', media_type: 'IMAGE', timestamp: iso(300), permalink: 'https://www.instagram.com/p/OLD2/', media_url: img, like_count: 88, comments_count: 11 },
  { id: 'OLD9', caption: 'Lip neutralisation, first session.', media_type: 'IMAGE', timestamp: iso(3), permalink: 'https://www.instagram.com/p/OLD9/', media_url: img, like_count: 31, comments_count: 4 },
];
export const INSIGHTS = { OLD1: { reach: 912, saved: 14, shares: 3, views: 1500 }, OLD2: { reach: 2430, saved: 41, shares: 22, views: 4100 }, OLD9: { reach: 640, saved: 9, shares: 2, views: 900 } };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.DEV_STORE_FILE = '../.devdata/ui-store.json';
  fs.rmSync(new URL('../.devdata/ui-store.json', import.meta.url), { force: true });
  const { record } = await import('../lib/web.js');
  const { kvSet } = await import('../lib/store.js');
  const { dayKey } = await import('../lib/time.js');
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  for (let d = 0; d < 14; d++) {
    const t = Date.now() - d * DAY;
    for (let i = 0; i < 9 + ((d * 7) % 11); i++) {
      const s = pick(['instagram', 'instagram', 'google', 'google', 'google-ads', 'direct', 'facebook', 'google-maps']);
      await record({ e: 'pv', s, p: pick(['/', '/', '/services/lip-blush-gold-coast.html', '/services/powder-brows-gold-coast.html']), n: 1 }, t);
      await record({ e: 'pv', s, p: '/services/cosmetic-tattooing.html', n: 0 }, t);
      if (i % 5 === 0) await record({ e: 'book', s, p: '/services/lip-blush-gold-coast.html' }, t);
    }
  }
  await kvSet(`snap:${dayKey(Date.now() - DAY)}`, { followers: 759, pageFollowers: 411, comments: 18 });
  await kvSet('heartbeat', { at: Date.now() - 12 * 60000, by: 'vercel' });
  console.log('Pretend data written to .devdata/ui-store.json');
}

export const startPreviewGraph = (port = 5199) => startMockGraph({ port, videoPolls: 0, media: MEDIA, insights: INSIGHTS });
