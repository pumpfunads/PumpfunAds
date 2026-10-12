/**
 * Every knob of the content engine, read once at import. Each adapter has its own mock switch, ON by default when its
 * key is missing, so a dev box (or a test) never calls a paid API by accident and never needs a key to boot.
 * ⛔ Mock output is LABELLED mock (an SVG card that says MOCK, `mock: true` on the asset): it must never pass for real
 *    media in the feed, and the admin overview shows each adapter's mode.
 */
import path from 'node:path';
import { env, flag, num } from '../env.mjs';
import { DB_PATH } from '../db.mjs';

/** On when MOCK_<NAME>=1, off when =0, otherwise on exactly when the adapter has no key. */
const mockFor = (name, hasKey) => {
  const v = env(`MOCK_${name}`, '');
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return !hasKey;
};

const hfKey = env('HIGGSFIELD_API_KEY', '') || (env('HF_API_KEY_ID', '') && env('HF_API_KEY_SECRET', '') ? `${env('HF_API_KEY_ID')}:${env('HF_API_KEY_SECRET')}` : '');

export const C = {
  publicUrl: env('PUBLIC_URL', 'https://pumpfunads.com').replace(/\/+$/, ''),
  mediaDir: env('MEDIA_DIR', path.join(path.dirname(DB_PATH), 'media')),

  // planner + safety
  intervalMs: num('PLANNER_INTERVAL_MIN', 10) * 60_000,
  autoApprove: flag('AUTO_APPROVE'),
  globalDailyUsd: num('GENERATION_DAILY_USD_CAP', 100), // operator 11 Oct: $100 a day across all coins
  concurrency: Math.max(1, Math.min(4, num('GENERATION_CONCURRENCY', 4))), // ⛔ never above 4 (operator rule)
  coinDailyUsd: num('COIN_DAILY_USD_CAP', 10),
  videosPerDay: num('VIDEOS_PER_DAY', 5), // operator 11 Oct: at most 5 videos a coin a day; the rest of its budget is for ad campaigns
  maxJobUsd: num('MAX_JOB_USD', 8),
  maxAttempts: num('CONTENT_MAX_ATTEMPTS', 2), // per step+seq: failed/rejected jobs beyond this are not retried
  llmJobUsd: num('LLM_JOB_USD', 0.01), // what one brief + moderation costs us, charged with each job

  // posting
  xPostsPerDay: num('X_POSTS_PER_DAY', 20),
  xPostsPerTick: num('X_POSTS_PER_TICK', 2),
  xPostUsd: num('X_POST_USD', 0.015), // X API pay-per-use: a post without a URL
  xLinkReply: env('X_LINK_REPLY_URL', ''), // e.g. https://pumpfunads.com/c/{mint}; empty = no link reply (a URL post costs $0.20)

  higgsfield: { key: hfKey, mock: mockFor('GENERATION', Boolean(hfKey)), base: env('HIGGSFIELD_BASE', 'https://api.higgsfield.ai') },
  // Claude through OpenRouter (OPENROUTER_API_KEY, the operator's existing key) or Anthropic direct (ANTHROPIC_API_KEY).
  // OpenRouter wins when both are set. Model ids differ: 'anthropic/claude-sonnet-5.5' there, 'claude-sonnet-5-5' direct.
  llm: (() => {
    const or = env('OPENROUTER_API_KEY', ''), an = env('ANTHROPIC_API_KEY', '');
    const provider = or ? 'openrouter' : 'anthropic';
    return { provider, key: or || an, mock: mockFor('LLM', Boolean(or || an)), model: env('LLM_MODEL', provider === 'openrouter' ? 'anthropic/claude-sonnet-5.5' : 'claude-sonnet-5-5') };
  })(),
  x: {
    apiKey: env('X_API_KEY', ''), apiSecret: env('X_API_SECRET', ''), accessToken: env('X_ACCESS_TOKEN', ''), accessSecret: env('X_ACCESS_SECRET', ''),
    clientId: env('X_CLIENT_ID', ''), clientSecret: env('X_CLIENT_SECRET', ''),
    handle: env('X_HANDLE', 'pumpfunads').replace(/^@/, ''),
    mock: mockFor('X', Boolean(env('X_API_KEY', '') && env('X_ACCESS_TOKEN', ''))),
    // creator OAuth is mocked separately: our own account can be live while the creator app waits for approval
    oauthMock: mockFor('X', Boolean(env('X_CLIENT_ID', ''))),
  },
  tiktok: { clientKey: env('TIKTOK_CLIENT_KEY', ''), clientSecret: env('TIKTOK_CLIENT_SECRET', ''), mock: mockFor('TIKTOK', Boolean(env('TIKTOK_CLIENT_KEY', ''))) },
};

export const redirectUri = (platform) => `${C.publicUrl}/api/oauth/${platform}/callback`;

export const modes = () => ({
  generation: C.higgsfield.mock ? 'mock' : 'live',
  llm: C.llm.mock ? 'mock' : `live (${C.llm.model})`,
  x: C.x.mock ? 'mock' : 'live',
  xCreatorOauth: C.x.oauthMock ? 'mock' : 'live',
  tiktok: C.tiktok.mock ? 'mock' : 'live',
});
