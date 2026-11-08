# Later phase: small ads with a hard weekly budget cap (design only, not built)

**Ads cost money, paid directly to Meta, whichever app creates them.** This phase only replaces the agency's fees and makes small, safe campaigns easy. It does not make ads free.

## What Crystal will be able to do

1. From the Calendar, tap a post that's doing well → **Boost**.
2. Pick: who (Women 22–45 within 15 km of Varsity Lakes, set by default), goal (more profile visits / messages / website bookings), and a daily amount (e.g. $10/day).
3. The app shows the weekly total before anything is created ("$10/day × 7 days = $70. Your weekly cap is $100. You have $30 left this week.").
4. **Pause** or **Stop** any running ad with one tap. See spend, reach and cost per result.

## The hard weekly cap: three layers

1. **Meta's own account spending limit (the backstop).** Crystal sets an *Account spending limit* in Meta Ads Manager → Billing → Payment settings. Meta itself stops all ads when it's reached, even if the app has a bug. The app reads it and refuses to start unless it's set.
2. **Every campaign has an end date and a lifetime budget.** No open-ended daily budgets. Each campaign is created with `lifetime_budget` and an `end_time` no more than 7 days out, so it can't keep spending.
3. **The app's weekly cap** (an environment variable, e.g. `ADS_WEEKLY_CAP_AUD=100`). Before creating or extending anything, the server adds up (a) the remaining lifetime budget of every active campaign and (b) what's been spent this week per the Insights API, and refuses if the new campaign would push the week over the cap. A daily check pauses everything if actual spend somehow exceeds the cap.

## Technical outline (for whoever builds it)

- **Permissions to add:** `ads_management`, `ads_read`, and access to Crystal's ad account (`act_<id>`). As the app's admin these work without App Review (standard access).
- **Token:** Page tokens can't run ads. Use a long-lived *system user* token from Business Settings → Users → System users, created by Crystal and saved by her in Vercel as `META_ADS_TOKEN`. Never in code.
- **Calls (Marketing API):**
  - `POST /act_<id>/campaigns` with `objective=OUTCOME_ENGAGEMENT` or `OUTCOME_TRAFFIC`, `status=PAUSED`, and `special_ad_categories=[]`.
  - `POST /act_<id>/adsets` with `lifetime_budget`, `end_time`, `billing_event=IMPRESSIONS`, `optimization_goal`, and `targeting` (geo radius around 5b/201 Varsity Parade, age 22–45, women).
  - `POST /act_<id>/ads` with `creative={ object_story_id or source_instagram_media_id }` to boost an existing post.
  - Only after Crystal taps **Confirm** in the app: set the campaign's status to `ACTIVE`.
  - `GET /act_<id>/insights?date_preset=this_week_mon_today&fields=spend,reach,actions` for the dashboard and the cap check.
- **Store** campaign IDs and the weekly ledger in the same Upstash database (`cc:ads:*`).
- **Confirmations:** every action that spends money shows the amount and asks "Start this ad for $X?", like the post review sheet.
- **Brand rules** still apply to ad text (same `guardrails.js`). Meta's ad policies also apply to cosmetic procedures: no before/after claims that imply guaranteed results.

## Not in scope

Lookalike audiences, pixels and conversion tracking, and A/B tests. They're worth considering only once small boosts are clearly paying back.
