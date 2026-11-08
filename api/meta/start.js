// Step 1 of connecting: send Crystal to Facebook's own login/permission screen.
// She logs in on facebook.com; this app never sees her password.
import { isLoggedIn, sign, randomToken } from '../../lib/auth.js';
import { GRAPH_VERSION } from '../../lib/graph.js';

export const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'business_management',
];

export function redirectUri(request) {
  const u = new URL(request.url);
  return `${u.origin}/api/meta/callback`;
}

export async function GET(request) {
  if (!isLoggedIn(request)) return Response.redirect(new URL('/', request.url), 302);
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return new Response('META_APP_ID and META_APP_SECRET need to be added in Vercel first (see the setup guide).', { status: 503 });
  }
  const nonce = randomToken();
  const params = new URLSearchParams({
    client_id: (process.env.META_APP_ID || "").trim(),
    redirect_uri: redirectUri(request),
    state: `${nonce}.${sign(nonce)}`,
    response_type: 'code',
  });
  if (process.env.META_LOGIN_CONFIG_ID) params.set("config_id", process.env.META_LOGIN_CONFIG_ID.trim());
  else params.set('scope', SCOPES.join(','));
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`,
      'set-cookie': `cc_oauth=${nonce}; Path=/api/meta; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
