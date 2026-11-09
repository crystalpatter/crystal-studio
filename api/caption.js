// AI caption + hashtag drafts in Crystal's voice, using Claude (Anthropic API).
// The phone sends small preview images (photos, or a frame from a video) plus
// Crystal's notes; Claude returns three caption options and hashtags.
import Anthropic from '@anthropic-ai/sdk';
import { authed, json, fail, body } from '../lib/http.js';
import { BRAND_BRIEF, CAPTION_RULES, POST_IDEAS } from '../lib/brand.js';
import { check } from '../public/js/guardrails.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          style: { type: 'string', description: 'Two or three words, e.g. "Warm & personal"' },
          caption: { type: 'string', description: 'Caption body without hashtags, ending in one call to action' },
        },
        required: ['style', 'caption'],
        additionalProperties: false,
      },
    },
    hashtags: { type: 'array', items: { type: 'string' } },
    what_i_see: { type: 'string', description: 'One sentence describing what is in the photos/video, so Crystal can check the AI understood it' },
  },
  required: ['options', 'hashtags', 'what_i_see'],
  additionalProperties: false,
};

const TYPE_LABEL = { image: 'a single photo post', carousel: 'a carousel (several photos/videos swiped through)', reel: 'a Reel (short vertical video)' };

export const POST = authed(async (request) => {
  if (!process.env.ANTHROPIC_API_KEY) return fail('The Claude API key (ANTHROPIC_API_KEY) has not been added in Vercel yet.', 503);
  const b = await body(request);
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).filter((d) => typeof d === 'string' && d.startsWith('data:image/jpeg;base64,'));
  const notes = String(b.notes || '').slice(0, 1500);
  const idea = POST_IDEAS[b.idea] || '';
  const type = TYPE_LABEL[b.type] || 'an Instagram post';
  if (!images.length && !notes) return fail('Add a photo or a few words about the post first.');

  const content = [
    ...images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d.slice('data:image/jpeg;base64,'.length) } })),
    {
      type: 'text',
      text: [
        `Write three caption options for ${type}${b.type === 'reel' ? ' (the image is a still frame from the video)' : ''}.`,
        idea && `Kind of post: ${idea}`,
        notes ? `Crystal's notes about this post: ${notes}` : 'Crystal gave no notes, so stick to what you can see.',
        b.facebook ? 'It will also be shared to Facebook.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  const client = new Anthropic();
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: `${BRAND_BRIEF}\n\n${CAPTION_RULES}`,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return fail('The Claude API key in Vercel is not valid. Check ANTHROPIC_API_KEY.', 502);
    if (err instanceof Anthropic.RateLimitError) return fail('Claude is busy. Try again in a minute.', 429);
    if (err instanceof Anthropic.APIError) {
      console.error('Claude API error', err.status, err.error?.error?.type, err.error?.error?.message);
      const detail = err.status === 400 && err.error?.error?.message ? `: ${String(err.error.error.message).slice(0, 200)}` : '';
      return fail(`Claude couldn't write a caption right now (${err.status})${detail}.`, 502);
    }
    throw err;
  }
  if (response.stop_reason === 'refusal') return fail("Claude wouldn't write a caption for this one. Try different notes or write it yourself.", 422);

  const text = response.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('The caption came back garbled. Please try again.', 502);
  }
  const hashtags = [...new Set((data.hashtags || []).map((h) => '#' + String(h).replace(/^#+/, '').replace(/\s+/g, '').toLowerCase()).filter((h) => h.length > 1))].slice(0, 15);
  const options = (data.options || []).slice(0, 3).map((o) => ({ ...o, warnings: check(o.caption) }));
  return json({ options, hashtags, hashtagWarnings: check(hashtags.join(' ')), whatISee: data.what_i_see || '' });
});
