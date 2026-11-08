// A pretend Meta Graph API for local testing. Records every call so tests can
// check exactly what would have been sent to Instagram and Facebook.
import http from 'node:http';

export function startMockGraph({ port = 5199, videoPolls = 2, fail = {} } = {}) {
  const calls = [];
  const containers = {};
  let n = 0;
  const id = (p) => `${p}${++n}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let body = '';
    for await (const c of req) body += c;
    const params = Object.fromEntries(req.method === 'GET' ? url.searchParams : new URLSearchParams(body));
    const p = url.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ method: req.method, path: p, params });
    const out = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (params.access_token !== 'test-token') return out(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
    if (fail[p]) {
      const f = fail[p];
      if (f.times-- > 0) return out(400, { error: f.error });
    }

    if (req.method === 'GET' && p === 'me')
      return out(200, { id: 'PAGE1', name: 'Crystal Cosmetics', instagram_business_account: { id: 'IG1', username: 'bycrystalcosmetics', followers_count: 763 } });
    if (req.method === 'POST' && p === 'IG1/media') {
      const cid = id('C');
      containers[cid] = { params, polls: params.media_type === 'REELS' || params.media_type === 'VIDEO' ? videoPolls : 0, published: false };
      return out(200, { id: cid });
    }
    if (req.method === 'POST' && p === 'IG1/media_publish') {
      const c = containers[params.creation_id];
      if (!c) return out(400, { error: { code: 100, message: 'Invalid creation_id' } });
      if (c.published) return out(400, { error: { code: 9007, message: 'Media already published' } });
      c.published = true;
      return out(200, { id: id('M') });
    }
    if (req.method === 'GET' && containers[p]) {
      const c = containers[p];
      if (c.published) return out(200, { status_code: 'PUBLISHED', id: p });
      if (c.polls > 0) {
        c.polls--;
        return out(200, { status_code: 'IN_PROGRESS', id: p });
      }
      return out(200, { status_code: 'FINISHED', id: p });
    }
    if (req.method === 'GET' && /^M\d+$/.test(p)) return out(200, { id: p, permalink: `https://www.instagram.com/p/${p}/` });
    if (req.method === 'GET' && p === 'IG1/media') return out(200, { data: [{ id: 'M1', permalink: 'https://www.instagram.com/p/M1/', caption: 'Healed lip blush', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: new Date().toISOString(), media_url: 'https://example.com/a.jpg', like_count: 12, comments_count: 2 }] });
    if (req.method === 'GET' && p === 'IG1/insights') {
      if (params.metric === 'profile_links_taps') return out(400, { error: { code: 100, message: 'metric not supported' } });
      return out(200, { data: [{ name: params.metric, total_value: { value: params.metric.length * 37 } }] });
    }
    if (req.method === 'GET' && /^M\d+\/insights$/.test(p)) return out(200, { data: [{ name: params.metric, values: [{ value: 5 }] }] });
    if (req.method === 'POST' && p === 'PAGE1/photos') return out(200, params.published === 'false' ? { id: id('FP') } : { id: id('FP'), post_id: `PAGE1_${n}` });
    if (req.method === 'POST' && p === 'PAGE1/feed') return out(200, { id: `PAGE1_${++n}` });
    if (req.method === 'POST' && p === 'PAGE1/videos') return out(200, { id: id('FV') });
    return out(404, { error: { code: 803, message: `Mock has no route for ${req.method} ${p}` } });
  });
  const failNext = (path, error) => (fail[path] = { times: 1, error });
  return new Promise((resolve) => server.listen(port, () => resolve({ calls, containers, failNext, close: () => server.close() })));
}
