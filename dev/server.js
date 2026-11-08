// Local test server (not deployed). Mimics Vercel: serves public/ and runs
// api/*.js handlers. Uses a file-based store and a /dev/upload endpoint instead
// of Upstash/Blob, so the whole app can be tried without any accounts.
//   PORT=5180 APP_PASSWORD=test node dev/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 5180);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const media = path.join(root, '.devdata', 'media');
fs.mkdirSync(media, { recursive: true });

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  // Local http: drop the Secure flag so the browser keeps the cookie.
  if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].replace(/; Secure/g, '');
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname === '/dev/upload' && req.method === 'POST') {
        const name = path.basename(url.searchParams.get('name') || `file-${Date.now()}`);
        const r = await toRequest(req);
        fs.writeFileSync(path.join(media, name), Buffer.from(await r.arrayBuffer()));
        return send(res, Response.json({ url: `${process.env.DEV_MEDIA_BASE || `http://localhost:${PORT}`}/dev/media/${name}` }));
      }
      if (url.pathname.startsWith('/dev/media/')) {
        const f = path.join(media, path.basename(url.pathname));
        if (!fs.existsSync(f)) return send(res, new Response('not found', { status: 404 }));
        return send(res, new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } }));
      }
      if (url.pathname.startsWith('/api/')) {
        const file = path.join(root, url.pathname.replace(/\/$/, '') + '.js');
        if (!fs.existsSync(file)) return send(res, Response.json({ error: 'No such API' }, { status: 404 }));
        const mod = await import(pathToFileURL(file).href);
        const handler = mod[req.method] || (req.method === 'HEAD' && mod.GET);
        if (!handler) return send(res, new Response('Method not allowed', { status: 405 }));
        return send(res, await handler(await toRequest(req)));
      }
      let f = path.join(root, 'public', decodeURIComponent(url.pathname));
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!f.startsWith(path.join(root, 'public')) || !fs.existsSync(f)) return send(res, new Response('Not found', { status: 404 }));
      return send(res, new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } }));
    } catch (err) {
      console.error(err);
      return send(res, Response.json({ error: err.message }, { status: 500 }));
    }
  })
  .listen(PORT, () => console.log(`Crystal Studio dev server: http://localhost:${PORT}`));
