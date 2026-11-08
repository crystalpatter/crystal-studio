# Crystal Studio

Post once to Instagram (@bycrystalcosmetics) and the Facebook Page for **Crystal Cosmetics**, from an iPhone home-screen app.

- AI-drafted captions and hashtags in Crystal's voice (Claude, following the brand brief's "Never" list).
- Photo, carousel and Reel publishing via the Instagram Graph API, then an optional Facebook Page post via the Pages API.
- Post now or schedule; calendar; small insights view.
- Later: small ads with a hard weekly cap ([docs/ADS-PHASE.md](docs/ADS-PHASE.md), design only).

**For Crystal:** [docs/SETUP.md](docs/SETUP.md) (one-time setup) · [docs/HOW-TO.md](docs/HOW-TO.md) (daily use) · [docs/DECISIONS.md](docs/DECISIONS.md) (why this route, costs, limits)

## How it's built

- `public/`: the app. Static HTML/CSS/JS installable as a PWA. No build step. `public/vendor/blob-client.js` is `@vercel/blob/client` bundled with `npm run vendor`.
- `api/`: Vercel functions (Web `Request`/`Response` handlers).
  - `login`, `status`, `upload` (Vercel Blob client-upload token), `caption` (Claude).
  - `posts`/`post` (create, list, edit, retry, delete), `run` + `cron` (publish due posts), `insights`.
  - `meta/start` + `meta/callback` (Facebook Login → shows the never-expiring Page token once so Crystal can paste it into Vercel).
- `lib/publisher.js`: resumable publishing state machine. It creates Instagram containers (carousel children first), waits for `FINISHED`, then `media_publish`, then Facebook (photo, multi-photo `attached_media`, or video). Every step is saved, so it's safe to call repeatedly. Per-post lock in Redis.
- `lib/store.js`: Upstash Redis (`KV_REST_API_*` / `UPSTASH_REDIS_REST_*`), with a JSON-file fallback for local dev.
- `.github/workflows/scheduler.yml`: calls `/api/cron` every 10 minutes (needs repo variable `APP_URL`; optional secret `CRON_SECRET`, which must match the Vercel env var of the same name). Monthly empty commit keeps GitHub from disabling the schedule.

## Environment variables (set by Crystal in Vercel)

| Name | Purpose |
|---|---|
| `APP_PASSWORD` | Login for the app |
| `ANTHROPIC_API_KEY` | Claude captions (`CLAUDE_MODEL` overrides the default `claude-opus-5-5`) |
| `BLOB_READ_WRITE_TOKEN` | Set automatically by Vercel Blob (store must be **public**) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Set automatically by Upstash Redis |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` (optional) | Meta app for the Connect flow |
| `META_PAGE_TOKEN` | Page access token from the Connect flow |
| `GRAPH_VERSION` | Optional, default `v26.0` |
| `CRON_SECRET` | Optional hardening for `/api/cron` |

## Local development

```bash
npm install
npm test        # end-to-end publishing tests against a mock Graph API
APP_PASSWORD=local-test npm run dev   # http://localhost:5180 (file store + /dev/upload, no accounts needed)
```
