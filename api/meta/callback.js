// Step 2 of connecting: Facebook sends Crystal back here. We swap the one-time
// code for a Page access token that doesn't expire and save it encrypted in
// the app's database (see lib/token.js), so reconnecting is a single tap.
import { isLoggedIn, readCookie, sign } from '../../lib/auth.js';
import { graph, GRAPH_VERSION, forgetToken } from '../../lib/graph.js';
import { saveToken } from '../../lib/token.js';
import { redirectUri } from './start.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, inner) {
  return new Response(
    `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css"></head>
<body class="connect"><main class="card">${inner}<p><a class="btn ghost" href="/#settings">Back to the app</a></p></main>
<script>document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{const t=document.getElementById(b.dataset.copy);t.select();try{await navigator.clipboard.writeText(t.value)}catch{document.execCommand('copy')}b.textContent='Copied ✓'})</script>
</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': 'cc_oauth=; Path=/api/meta; Max-Age=0' } }
  );
}

async function exchange(params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.access_token;
}

export async function GET(request) {
  if (!isLoggedIn(request)) return page('Log in first', '<h1>Please log in to the app first</h1>');
  const u = new URL(request.url);
  if (u.searchParams.get('error')) {
    return page('Not connected', `<h1>Not connected</h1><p>Facebook said: ${esc(u.searchParams.get('error_description') || u.searchParams.get('error'))}</p><p>You can try again from Settings.</p>`);
  }
  const [nonce, sig] = String(u.searchParams.get('state') || '').split('.');
  if (!nonce || nonce !== readCookie(request, 'cc_oauth') || sig !== sign(nonce)) {
    return page('Try again', '<h1>That link expired</h1><p>Please tap Connect again from Settings.</p>');
  }

  try {
    const shortToken = await exchange({
      client_id: (process.env.META_APP_ID || "").trim(),
      client_secret: (process.env.META_APP_SECRET || "").trim(),
      redirect_uri: redirectUri(request),
      code: u.searchParams.get('code'),
    });
    // Long-lived user token → Page tokens made from it never expire.
    const longToken = await exchange({
      grant_type: 'fb_exchange_token',
      client_id: (process.env.META_APP_ID || "").trim(),
      client_secret: (process.env.META_APP_SECRET || "").trim(),
      fb_exchange_token: shortToken,
    });
    const pages = await graph('GET', 'me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 50 }, { token: longToken });
    const list = (pages.data || []).sort((a, b) => Number(Boolean(b.instagram_business_account)) - Number(Boolean(a.instagram_business_account)));
    if (!list.length) {
      return page('No Page found', `<h1>No Facebook Page found</h1><p>Facebook didn't share any Pages with the app. Tap Connect again and, on the Facebook screen, choose <b>Edit access</b> (or <b>Edit settings</b>) and tick your Crystal Cosmetics Page and Instagram account.</p>`);
    }
    // Save the token (encrypted) for the Page that has Instagram linked, so there
    // is nothing to copy or paste. It is never shown, logged or sent anywhere else.
    const chosen = list[0];
    const ig = chosen.instagram_business_account;
    if (!ig) {
      return page('Instagram not linked', `<h1>No Instagram account is linked to your Page</h1><p>Facebook shared <b>${esc(chosen.name)}</b>, but it has no Instagram Business account linked. Link @bycrystalcosmetics to the Page first (setup guide, Part 1), then tap Connect again.</p>`);
    }
    await saveToken(chosen.access_token, { page: chosen.name, ig: ig.username });
    forgetToken();
    return page(
      'Connected',
      `<h1>Connected ✓</h1>
<p>Crystal Studio is now connected to <b>@${esc(ig.username)}</b> on Instagram and the <b>${esc(chosen.name)}</b> Facebook Page.</p>
<p>There's nothing else to do. Scheduled posts and Autopilot carry on from here.</p>
<p class="small">The connection is stored encrypted and is only used to post and read your own stats. If you ever think it has leaked, change your Facebook password and connect again.</p>`
    );
  } catch (err) {
    return page('Not connected', `<h1>Something went wrong</h1><p>${esc(err.userMessage || err.message)}</p><p>Check META_APP_ID and META_APP_SECRET in Vercel, then try again.</p>`);
  }
}
