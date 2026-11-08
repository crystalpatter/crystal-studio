# Crystal Studio: decisions and costs

*8 November 2026*

## The route: a small custom app, with Meta Business Suite as the free backup

| Option | What it costs | Good | Not so good | Verdict |
|---|---|---|---|---|
| **Meta Business Suite** (Meta's free app) | Free | Already posts and schedules to Instagram + Facebook together, shows ad results. Nothing to set up. | No AI captions in your voice, no guard against off-brief claims. | **Use it now and keep it as the backup.** |
| **Postiz Cloud** (hosted) | About US$29–49/month (prices checked Aug 2026) | No Meta developer app needed: you just click "connect". Calendar, AI, many networks. | A monthly fee forever. Generic AI that doesn't know your prices or "Never" list. Your content sits with another company. | Best "no-build" option if the custom app is ever abandoned. |
| **Postiz self-hosted** (open source) | Free software, but needs a server (~US$10–20/month) | Full control. | Needs a server running Docker, a Postgres database, Redis and Temporal, plus updates and your own Meta developer app anyway. Not realistic to look after yourself. | Not recommended. |
| **Crystal Studio** (this app) | About A$1–3/month (see below) | Built around your brief: captions in your voice, your prices, warnings on the "Never" list. Posts to Instagram then Facebook. Calendar and insights. Room to add ads with a hard weekly cap. | One-off setup with Meta (about 45 minutes, steps provided). If Meta changes its API, the app may need a small update. | **Recommended and built.** |

## Where it lives

- **New GitHub repo `crystalpatter/crystal-studio`**, deployed as its **own Vercel project** (not inside the website repo).
  - The website repo has an AI agent that pushes changes to it three times a day. Keeping the posting app separate means that agent can never touch the app's code, and the website never has access to the app's Instagram/Facebook token.
  - If one of them has a bad deploy, the other keeps working.
  - The repo is **public** (like the website's). It contains no passwords or tokens: those live only in Vercel's encrypted settings. Public repos get GitHub's scheduler for free, which publishes scheduled posts every 10 minutes.
- **Address:** `https://crystal-studio.vercel.app` (or similar; Vercel shows it after the first deploy). It can later become `studio.crystalcosmetics.com.au` with one DNS record at GoDaddy, which is optional.

## How it works (one paragraph)

You pick photos or a video in the app. Photos are converted to JPEG and cropped to Instagram's shape on your phone, then uploaded to Vercel Blob (file storage). Claude (Anthropic's AI) drafts three captions plus hashtags from small previews and your notes, following your brand brief. When you post, the app asks Instagram to create the post from the uploaded file, waits for it to process, publishes it, then posts the same caption to your Facebook Page, with "link in bio" swapped for "link below" and the booking link added underneath. Scheduled posts are saved in a small database (Upstash Redis) and published by a scheduler that GitHub runs every 10 minutes.

## Running costs

| Item | Cost |
|---|---|
| Vercel hosting, Blob storage (1 GB free), Upstash Redis (free tier) | $0 on the free plans |
| GitHub scheduler | $0 (public repo) |
| Instagram/Facebook API | $0 |
| AI captions (Claude Opus 5.5) | About 5 US cents per "Write my caption" tap. 12 posts a month with a couple of drafts each comes to roughly US$1–2/month. Set a spend limit in the Anthropic Console. |
| **Paid ads (later phase)** | **Whatever budget you set, paid directly to Meta.** The app removes agency fees (about $172/week as of September), not the cost of the ads themselves. |

**One thing to know:** Vercel's free "Hobby" plan is meant for personal, non-commercial use. Your website is already on it. If Vercel ever asks, the Pro plan is US$20/month and covers both projects.

## Known limits

- **Scheduling accuracy:** GitHub's scheduler can run a few minutes late when it's busy, so a 6:00pm post may go out between about 6:00 and 6:20pm. Opening the app also publishes anything that's overdue.
- **Instagram Stories** can't be posted by this app yet (only feed photos, carousels and Reels). Post Stories from the Instagram app.
- **Facebook carousels** become a multi-photo post. If a carousel mixes photos and videos, Facebook gets the photos only.
- **Music** can't be added to Reels through Meta's API. Add trending audio in the Instagram app before exporting, or post that Reel from Instagram directly.
- **Editing or deleting** a post that's already live is done in the Instagram/Facebook apps. The app's "Remove" only takes it off the calendar.
