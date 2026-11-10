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

## Autopilot and the morning report (10 November 2026)

**Goal:** posts keep going out and Crystal knows what's happening each morning, without paying a scheduling company and without relying on her having time that day.

- **Runs in the cloud, not on the Mac.** A desktop program only works while the Mac is on and awake. This runs inside the existing app on Vercel, so it works from anywhere and she controls it from her phone.
- **Triggers:** Vercel's free scheduler allows jobs that run once a day, some time within their hour. `vercel.json` has one per hour. Each run publishes anything due, lets Autopilot fill today's slot, and sends the morning report if it's due (the 7am run builds it and asks the email service to hold it until 8:00; the 8am run is the backup). GitHub's scheduler stays as a second backup: in practice it was only firing a few times a day, not every 10 minutes, which is why it's no longer the main trigger.
- **Content bank + re-shares:** see `lib/autopilot.js` and `lib/evergreen.js`. A re-share is an ordinary scheduled post on the Calendar, so it can be moved, skipped or swapped. Files are copied from Instagram into Blob storage first (Instagram's links expire in hours); video copies are deleted two days after the re-share is live so storage doesn't fill up.
- **Approvals:** off by default for re-shares because the brief is "don't depend on Crystal". "Ask me first" is one switch. Email buttons are signed links that open a confirm page, so an email scanner opening the link can't approve or cancel anything.
- **Email:** Resend's free plan (100 a day). It's the one new account in this phase; nothing free can send email without one.
- **Website numbers:** the website's `js/main.js` sends an anonymous ping to `/api/t` (page viewed / Book tapped / call tapped / form sent, plus a rough source such as Instagram or Google Ads). No cookies, nothing stored about the visitor, so no consent banner is needed. Chosen over Google Analytics to keep everything in one report and avoid another account.
- **Instagram/Facebook connection now lives in the database, encrypted** (`lib/token.js`), instead of being pasted into Vercel. Reason: the connection expired within a day of first being set up, and the old fix was six steps on a computer. Now it's "tap Reconnect, log in on Facebook". The key is derived from `META_APP_SECRET`, which stays in Vercel only. An old `META_PAGE_TOKEN` in Vercel still works as a fallback and can be deleted once reconnected.

- **Heads-up:** Vercel's dashboard now labels Cron Jobs as "legacy" and points to its newer "Schedules" feature. The 24 hourly jobs are registered and running; if Vercel ever retires Cron Jobs, move the same list to Schedules (same free limits at the time of writing).
- **12-function limit:** Vercel's free plan allows at most 12 files under `api/`. The project is at exactly 12, which is why login lives in `api/status.js` and the report in `api/autopilot.js`. A new endpoint has to share a file with an existing one.

**Not connected (and why):**
- **Confirmed bookings from Timely.** Timely has no free way to hand bookings to another app. The report counts taps on the website's booking buttons instead.
- **Google Ads / Meta Ads accounts.** The report shows whether ad clicks are reaching the website, which catches "the ads stopped". Spend and campaign status would need Google's and Meta's ads APIs (a Google developer token, and a Meta system-user token with `ads_read`).
- **Replying to comments and DMs automatically.** Meta only allows this for apps that pass its App Review. The report tells her when new comments arrive instead.

## Leads, the new name and ElevenLabs (10 November 2026, later)

- **Name:** the app is now **Marketing Hub** everywhere Crystal sees it. The web address, the GitHub repo and the Meta app keep the name `crystal-studio` / "Crystal Studio": changing those would break the Facebook login (its return address is registered with Meta). The Meta display name can be changed by hand in Meta → App settings → Basic.
- **Leads:** `lib/leads.js` reads comments on her Instagram posts and comments + reactions on her Page posts, and keeps each person (public name, comment, date) for 6 months. Meta does not expose who liked an Instagram post, nor anyone's phone or email, to any app. Comments on *ads* that aren't also ordinary posts need the ad account connected (`ads_read`), which is not done. The privacy page was updated to say this list is kept.
- **Desktop app:** `~/Applications/Marketing Hub.app` on Crystal's Mac is a small launcher that opens the Hub in its own Chrome window. A background program isn't needed because the automation runs online. A fully native app would add maintenance and nothing she can't already do.
- **ElevenLabs:** key is pasted in Settings, checked against ElevenLabs and stored encrypted like the Meta connection. Only the connection exists so far. Its free plan has no commercial licence.
