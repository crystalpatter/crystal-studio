// Where posts are saved. On Vercel this is a free Upstash Redis database that
// Crystal adds from the Vercel dashboard (Storage → Upstash Redis), which sets
// KV_REST_API_URL / KV_REST_API_TOKEN automatically. Locally (npm run dev)
// with no database configured, it falls back to a JSON file in .devdata/.
import { Redis } from '@upstash/redis';

const P = 'cc:';
const POST = (id) => `${P}post:${id}`;
const ALL = `${P}posts`; // sorted set: score = the post's calendar time
const QUEUE = `${P}queue`; // sorted set: score = when to next try publishing
const LOCK = (id) => `${P}lock:${id}`;
const CACHE = (k) => `${P}cache:${k}`;

function redisFromEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export function storeConfigured() {
  return Boolean(redisFromEnv());
}

// ---- Tiny file-backed stand-in for local development only ----
class DevStore {
  constructor() {
    this.file = new URL(process.env.DEV_STORE_FILE || '../.devdata/store.json', import.meta.url);
    this.data = null;
  }
  async load() {
    if (this.data) return this.data;
    const fs = await import('node:fs');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { kv: {}, z: {} };
    }
    return this.data;
  }
  async save() {
    const fs = await import('node:fs');
    fs.mkdirSync(new URL('../.devdata/', import.meta.url), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }
  async get(k) {
    const d = await this.load();
    const e = d.kv[k];
    if (!e || (e.exp && e.exp < Date.now())) return null;
    return structuredClone(e.v);
  }
  async set(k, v, opts = {}) {
    const d = await this.load();
    const cur = await this.get(k);
    if (opts.nx && cur !== null) return null;
    d.kv[k] = { v, exp: opts.ex ? Date.now() + opts.ex * 1000 : 0 };
    await this.save();
    return 'OK';
  }
  async del(k) {
    const d = await this.load();
    delete d.kv[k];
    await this.save();
  }
  async mget(...keys) {
    return Promise.all(keys.map((k) => this.get(k)));
  }
  async zadd(k, { score, member }) {
    const d = await this.load();
    (d.z[k] ||= {})[member] = score;
    await this.save();
  }
  async zrem(k, member) {
    const d = await this.load();
    if (d.z[k]) delete d.z[k][member];
    await this.save();
  }
  async zrange(k, min, max, opts = {}) {
    const d = await this.load();
    const entries = Object.entries(d.z[k] || {})
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
    return opts.count ? entries.slice(opts.offset || 0, (opts.offset || 0) + opts.count) : entries;
  }
}

let client;
function db() {
  if (client) return client;
  const redis = redisFromEnv();
  if (redis) return (client = redis);
  if (process.env.VERCEL) {
    const e = new Error('The posts database is not connected yet. In Vercel, add Storage → Upstash Redis to this project, then redeploy.');
    e.userMessage = e.message;
    throw e;
  }
  return (client = new DevStore());
}

function zrangeByScore(k, min, max, limit) {
  const opts = { byScore: true };
  if (limit) Object.assign(opts, { offset: 0, count: limit });
  return db().zrange(k, min, max, opts);
}

export async function getPost(id) {
  return db().get(POST(id));
}

export async function savePost(post) {
  post.updatedAt = Date.now();
  await db().set(POST(post.id), post);
  await db().zadd(ALL, { score: calendarTime(post), member: post.id });
  return post;
}

export async function deletePost(id) {
  await db().del(POST(id));
  await db().zrem(ALL, id);
  await db().zrem(QUEUE, id);
}

export function calendarTime(post) {
  return post.publishedAt || post.scheduledAt || post.createdAt;
}

export async function listPosts(from, to) {
  const ids = await zrangeByScore(ALL, from, to);
  if (!ids.length) return [];
  const posts = await db().mget(...ids.map(POST));
  return posts.filter(Boolean);
}

// Publishing queue
export async function enqueue(id, when) {
  await db().zadd(QUEUE, { score: when, member: id });
}
export async function dequeue(id) {
  await db().zrem(QUEUE, id);
}
export async function dueIds(now = Date.now(), limit = 10) {
  return zrangeByScore(QUEUE, 0, now, limit);
}

// Stops two publish runs (the phone and the scheduler) working on one post at once.
export async function lock(id, seconds = 90) {
  return (await db().set(LOCK(id), Date.now(), { nx: true, ex: seconds })) === 'OK';
}
export async function unlock(id) {
  await db().del(LOCK(id));
}

export async function cacheGet(k) {
  return db().get(CACHE(k));
}
export async function cacheSet(k, v, seconds) {
  await db().set(CACHE(k), v, { ex: seconds });
}
