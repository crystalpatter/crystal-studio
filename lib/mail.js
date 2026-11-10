// Sends the morning email through Resend (free plan: 100 emails a day).
// Needs RESEND_API_KEY in Vercel. Until Crystal verifies her own domain with
// Resend, emails come from Resend's shared address and can only be delivered
// to the address she signed up to Resend with.
export function mailConfigured() {
  return Boolean((process.env.RESEND_API_KEY || '').trim());
}

export function mailFrom() {
  return (process.env.REPORT_EMAIL_FROM || 'Marketing Hub <onboarding@resend.dev>').trim();
}

export async function sendMail({ to, subject, html, text, sendAt }) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'not-configured', error: 'RESEND_API_KEY has not been added in Vercel yet.' };
  if (!to) return { ok: false, reason: 'no-recipient', error: 'No email address has been set for the morning report.' };
  const body = { from: mailFrom(), to: [to], subject, html, text };
  if (sendAt) body.scheduled_at = new Date(sendAt).toISOString();
  let res;
  try {
    res = await fetch(`${process.env.RESEND_BASE || 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, reason: 'network', error: `Could not reach the email service (${err.name}).` };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, id: data.id || null, scheduled: Boolean(sendAt) };
  const message = data.message || data.error?.message || `HTTP ${res.status}`;
  let reason = 'rejected';
  if (res.status === 401 || res.status === 403) reason = /only send testing emails|verify a domain/i.test(message) ? 'own-address-only' : 'bad-key';
  if (sendAt && res.status >= 400 && res.status < 500 && /schedul/i.test(message)) reason = 'no-scheduling';
  const friendly =
    reason === 'own-address-only'
      ? "The email service will only deliver to the address its account was opened with until the crystalcosmetics.com.au domain is verified there. Set the report address to that same address, or verify the domain."
      : reason === 'bad-key'
        ? 'The email key in Vercel (RESEND_API_KEY) was not accepted.'
        : `The email service said: ${String(message).slice(0, 200)}`;
  return { ok: false, reason, error: friendly };
}
