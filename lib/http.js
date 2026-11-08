import { isLoggedIn } from './auth.js';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export function fail(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

// Wrap a handler so it only runs for a logged-in Crystal, and so any crash
// comes back as a readable message instead of a blank 500.
export function authed(handler) {
  return async (request) => {
    if (!isLoggedIn(request)) return fail('Please log in again.', 401);
    try {
      return await handler(request);
    } catch (err) {
      console.error(err);
      return fail(err.userMessage || err.message || 'Something went wrong.', err.status || 500);
    }
  };
}

export async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function query(request) {
  return new URL(request.url).searchParams;
}
