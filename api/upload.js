// Gives the phone a short-lived permission slip to upload a photo/video
// straight to Vercel Blob (big videos can't go through a normal function).
import { handleUpload } from '@vercel/blob/client';
import { isLoggedIn } from '../lib/auth.js';
import { json, fail } from '../lib/http.js';

export async function POST(request) {
  const payload = await request.json();
  try {
    const result = await handleUpload({
      body: payload,
      request,
      onBeforeGenerateToken: async () => {
        if (!isLoggedIn(request)) throw new Error('Please log in again.');
        return {
          allowedContentTypes: ['image/jpeg', 'video/mp4', 'video/quicktime'],
          maximumSizeInBytes: 1024 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    return json(result);
  } catch (err) {
    return fail(err.message, 400);
  }
}
