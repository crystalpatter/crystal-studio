# Setting up Crystal Studio (one time, about 45 minutes)

Do this on your **Mac** in Safari or Chrome. It's easier than on the phone. You do every login yourself; nobody else needs your passwords.

**Golden rule:** the passwords, keys and tokens below only ever get typed or pasted into **Vercel → Settings → Environment Variables**. Never into a message, email, or chat (including Claude).

If any screen looks different from these steps (Meta changes its screens often), take a screenshot and ask. Don't guess.

---

## Part 1: Check Instagram is a Business account linked to your Facebook Page (5 min)

1. In the **Instagram** app, go to your profile → **☰** (top right) → **Settings and activity** → **Account type and tools**.
   - If you see **Switch to personal account**, you're already a professional account. Good.
   - If you see **Switch to professional account**, tap it and choose **Business**.
2. Open **Meta Business Suite** (business.facebook.com on the Mac, or the app) → ⚙ **Settings** → **Accounts** → **Instagram accounts**.
   - **@bycrystalcosmetics** should be listed and connected to the **Crystal Cosmetics** Page.
   - If it isn't, click **Add** / **Connect Instagram account** and log in to Instagram when asked.

## Part 2: Put the app online with Vercel (10 min)

1. Go to **vercel.com** and log in (the same way you do for the website).
2. **Add New…** → **Project** → find **crystal-studio** → **Import**.
   - If it's not in the list: **Adjust GitHub App Permissions** → allow **crystal-studio** → back to Vercel.
3. Leave everything as it is (Framework: **Other**) → **Deploy**. Wait for the confetti.
4. Click **Continue to Dashboard**. Your app's address is **crystal-studio-seven.vercel.app** (shown under **Domains**).
5. **Photo storage:** click **Storage** (top menu) → **Create Database** → **Blob** → name it `crystal-studio-media`.
   - If it asks about access, choose **Public**. Instagram has to be able to fetch the photos.
   - **Create** → connect it to **crystal-studio** (all environments) → **Connect**.
6. **Post calendar database:** **Storage** → **Create Database** → **Upstash for Redis** (under Marketplace) → **Free** plan → region **Sydney** if offered → name `crystal-studio-db` → **Create** → connect it to **crystal-studio**.
7. **Your app password and AI key:** project → **Settings** → **Environment Variables**. Add each of these with **Add** (tick all environments), then **Save**:

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | A password you make up for the app (long and unique; save it in your iPhone Passwords app). |
   | `ANTHROPIC_API_KEY` | From **console.anthropic.com** → **API keys** → **Create key** → name it `crystal-studio` → copy. It's shown only once. While you're there, set a monthly **spend limit** (e.g. US$10) under **Limits**. |

8. **Deployments** (top menu) → **⋯** next to the newest one → **Redeploy** → **Redeploy**. (Vercel only picks up new settings after a redeploy.)
9. Open **https://crystal-studio-seven.vercel.app** → log in with your app password. Settings should show ✓ for App password, AI captions, Photo storage and Post calendar database.

## Part 3: Create the Meta app (15 min)

This is the "key" that lets Crystal Studio post to your accounts. It's free, it's only used by you, and it doesn't need Meta's App Review because you're the app's admin.

1. Go to **developers.facebook.com** → **Log in** with the Facebook account that manages the Crystal Cosmetics Page.
   - First time? Click **Get Started** and verify your phone/email.
2. **My Apps** → **Create App**.
   - **App name:** `Crystal Studio`. **Contact email:** `info@crystalcosmetics.com.au`.
   - **Use case:** choose **Other** → **Next**.
   - **App type:** **Business** → **Next**.
   - **Business portfolio:** choose **Crystal Cosmetics** if it's listed (otherwise skip) → **Create app**. Facebook may ask for your password again; that's on Facebook's own page.
3. **Add products** (on the app's dashboard):
   - Find **Facebook Login for Business** → **Set up**.
   - If you see **Instagram** → **Set up** → choose **API setup with Facebook login**.
4. **Facebook Login for Business** → **Settings** (left menu):
   - **Valid OAuth Redirect URIs:** `https://crystal-studio-seven.vercel.app/api/meta/callback`
   - **Save changes**.
5. **Facebook Login for Business** → **Configurations** → **Create configuration**:
   - Name: `Crystal Studio`. Login variation: **General**. Token type: **User access token**.
   - Tick these permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `business_management`.
   - **Create**, then copy the **Configuration ID** (a long number).
   - (If there is no Configurations section, skip this step. The app will ask for the permissions directly.)
6. **App settings** → **Basic**:
   - **App domains:** `crystal-studio-seven.vercel.app`
   - **Privacy Policy URL:** `https://crystal-studio-seven.vercel.app/privacy.html`
   - **User data deletion:** choose **Data deletion instructions URL** → `https://crystal-studio-seven.vercel.app/privacy.html`
   - **Category:** Business and pages.
   - **Save changes**.
   - Click **Show** next to **App secret** (Facebook asks for your password).
7. Back in **Vercel → Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `META_APP_ID` | The **App ID** (top of App settings → Basic). |
   | `META_APP_SECRET` | The **App secret** you just revealed. |
   | `META_LOGIN_CONFIG_ID` | The **Configuration ID** from step 5 (skip if you didn't get one). |

   Then **Deployments** → **⋯** → **Redeploy**.
8. In the Meta app dashboard, switch **App mode** from **Development** to **Live** (toggle at the top). Meta can hide posts made by apps still in Development mode, so this makes sure everyone sees them. If it asks for anything else, screenshot it and ask.

## Part 4: Connect Instagram and Facebook (5 min)

1. Open **https://crystal-studio-seven.vercel.app** → **Settings** → **Connect Instagram & Facebook**.
2. On Facebook's screen, continue as yourself. When it asks which Pages and Instagram accounts: choose **Crystal Cosmetics** and **@bycrystalcosmetics**, and allow everything it asks.
3. You'll come back to a page that says **"Almost done: save your token in Vercel"**. Follow it:
   - **Copy token** (the box for the Page showing @bycrystalcosmetics).
   - Vercel → **Settings** → **Environment Variables** → add `META_PAGE_TOKEN` → paste → **Save**.
   - **Deployments** → **⋯** → **Redeploy**.
4. Open the app → **Settings** should show ✓ **Instagram @bycrystalcosmetics** and ✓ **Facebook Page Crystal Cosmetics**.

The token doesn't expire on its own. If you ever change your Facebook password, or Settings says the connection expired, just do Part 4 again.

## Part 5: Put it on your iPhone home screen (2 min)

1. On your iPhone, open **Safari** → go to **https://crystal-studio-seven.vercel.app**.
2. Tap **Share** (the square with the arrow) → **Add to Home Screen** → name it **CC Studio** → **Add**.
3. Open **CC Studio** from your home screen and log in once with your app password. It stays logged in.

On your Mac: open the address in Safari → **File** → **Add to Dock**.

## Part 6: Turn on the scheduler (1 min, or ask Claude to do it)

Scheduled posts need GitHub to "knock on the door" every 10 minutes.

1. Go to **github.com/crystalpatter/crystal-studio** → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**.
2. Name: `APP_URL`. Value: `https://crystal-studio-seven.vercel.app` (no slash at the end). **Add variable**.

This is just the app's address, not a secret, so Claude can do this step for you if you tell it the address.

---

## What's stored where

| What | Where | Who can see it |
|---|---|---|
| Your app password, AI key, Meta app secret, Page token | Vercel environment variables (encrypted) | Only people with access to your Vercel account |
| Photos/videos you post | Vercel Blob (public links, like any Instagram photo) | Anyone with the exact link |
| Captions and the post calendar | Upstash Redis via Vercel | Only the app |
| The app's code | GitHub (public, no secrets in it) | Anyone |

**If you think a key has leaked:** delete it where it was made (Anthropic Console for the AI key; Meta app → Settings → Basic → **Reset** for the app secret; change your Facebook password for the Page token), make a new one, update it in Vercel, and redeploy.
