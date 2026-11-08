// Step 2 of connecting: Facebook sends Crystal back here. We swap the one-time
// code for a Page access token that doesn't expire, and show it to her ONCE so
// she can paste it into Vercel as META_PAGE_TOKEN. It's never stored or logged
// by the app; only Vercel's encrypted environment variables hold it.
import { isLoggedIn, readCookie, sign } from '../../lib/auth.js';
import { graph, GRAPH_VERSION } from '../../lib/graph.js';
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
    const items = list
      .map((p, i) => {
        const ig = p.instagram_business_account;
        return `<section class="token-box">
<h2>${esc(p.name)}</h2>
<p>${ig ? `Instagram linked: <b>@${esc(ig.username)}</b> ✓` : '⚠️ No Instagram account is linked to this Page. Link it first (setup guide, Part 1), then connect again.'}</p>
${ig ? `<label for="t${i}">Your META_PAGE_TOKEN (keep it private)</label>
<textarea id="t${i}" readonly rows="4">${esc(p.access_token)}</textarea>
<button class="btn" data-copy="t${i}">Copy token</button>` : ''}
</section>`;
      })
      .join('');
    return page(
      'Connected: one last step',
      `<h1>Almost done: save your token in Vercel</h1>
<ol>
<li>Tap <b>Copy token</b> below (for the Page with <b>@bycrystalcosmetics</b>).</li>
<li>Open <b>vercel.com</b> → your <b>crystal-studio</b> project → <b>Settings</b> → <b>Environment Variables</b>.</li>
<li>Add a variable named <code>META_PAGE_TOKEN</code>, paste the token as the value, tick all environments, and <b>Save</b>. (If it already exists, edit it and paste the new one.)</li>
<li>Go to <b>Deployments</b>, tap the ⋯ next to the top one, and choose <b>Redeploy</b>.</li>
<li>Come back to the app → <b>Settings</b>. It should now say <b>@bycrystalcosmetics connected</b>.</li>
</ol>
<p class="small">This token lets the app post to your Page and Instagram. It isn't saved anywhere except where you paste it. Don't share it or put it in messages or emails. If you ever think it's leaked, change your Facebook password and connect again.</p>
${items}`
    );
  } catch (err) {
    return page('Not connected', `<h1>Something went wrong</h1><p>${esc(err.userMessage || err.message)}</p><p>Check META_APP_ID and META_APP_SECRET in Vercel, then try again.</p>`);
  }
}
