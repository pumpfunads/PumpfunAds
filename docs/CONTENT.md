# Content engine (api/content)

"Launch it, we market it." Each coin's budget
(`api/ledger.mjs`, its creator fees after the 20% burn) buys content on the unlock ladder (`lib/ladder.mjs`). The
engine plans, pays, generates, moderates, holds for review and posts. It runs inside the main process (`content.start()`).

```
planner tick (10 min)  ->  due step?  ->  policy + caps  ->  ledger.spend (job:<id>)  ->  Claude brief
   ->  moderation (local copy rules + Claude)  ->  Higgsfield images / video  ->  data/media/<mint>/
   ->  review (admin)  ->  approved  ->  our X (capped) | our TikTok (download queue) | creator X / TikTok inbox
failed or rejected  ->  ledger.refund (job:<id>)
```

## Files

| file | what |
|---|---|
| `config.mjs` | every env var below, the mock switch per adapter |
| `schema.mjs` | tables: `jobs`, `assets`, `posts`, `socials`, `oauth_states`, `content_policy`, `decisions` |
| `planner.mjs` | due steps, policy, caps, spend/refund, job runner (concurrency), `onLaunched`, `setGraduatedReader` |
| `posting.mjs` | distribution of approved jobs, X daily cap, TikTok download queue, creator accounts |
| `higgsfield.mjs` | generation (images, image-to-video), `/estimate`, polling, download; model ids in `MODELS` |
| `llm.mjs` | Claude: creative brief per step, moderation (structured outputs) |
| `x.mjs` | X API v2: OAuth 1.0a (ours), OAuth 2.0 PKCE (creators), chunked media upload, posts |
| `tiktok.mjs` | TikTok Login Kit + Content Posting API inbox upload (creators only) |
| `socials.mjs` | linking creator accounts, encrypted tokens, single-use OAuth state |
| `copy.mjs` | copy rules (no emojis, hashtags, `--`, CA, price, "buy", promises; "Pumpfun") |
| `media.mjs` | file paths, mock media, safe serving with byte ranges |
| `logo.mjs` | `generateLogo()` for the launch form (3 per wallet per UTC day, paid by Ads, counted in the global cap) |
| `routes.mjs` | HTTP routes |

## Environment

| var | default | what |
|---|---|---|
| `HIGGSFIELD_API_KEY` | none | `key_id:key_secret` from console.higgsfield.ai (or `HF_API_KEY_ID` + `HF_API_KEY_SECRET`) |
| `OPENROUTER_API_KEY` | none | Claude through OpenRouter, for briefs and moderation (used when set) |
| `ANTHROPIC_API_KEY` | none | Claude direct, the alternative to OpenRouter |
| `LLM_MODEL` | `anthropic/claude-sonnet-5.5` (OpenRouter) or `claude-sonnet-5-5` (direct) | Claude model ($2 / $10 per million tokens in/out) |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | none | OAuth 1.0a user context of @pumpfunads (our posts) |
| `X_HANDLE` | `pumpfunads` | used to build post URLs |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | none | OAuth 2.0 app for creators' X (PKCE, confidential client) |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | none | TikTok app for creators' inbox drafts |
| `MOCK_GENERATION`, `MOCK_LLM`, `MOCK_X`, `MOCK_TIKTOK` | on when the key is missing | `1` forces mock, `0` forces live |
| `AUTO_APPROVE` | `0` | `1` skips the admin review (not before the first weeks of real output) |
| `GENERATION_DAILY_USD_CAP` | `100` | all coins together, per UTC day (reservations of live jobs + provider cost of failed ones) |
| `GENERATION_CONCURRENCY` | `4` | jobs generating at once (clamped to 1..4) |
| `COIN_DAILY_USD_CAP` | `10` | one coin per UTC day (budget-paid jobs) |
| `VIDEOS_PER_DAY` | `5` | videos per coin per UTC day; the rest of the budget is for ad campaigns (admin: Ad campaigns, record ad spend) |
| `MAX_JOB_USD` | `8` | no single job above this (the trailer is ~$6) |
| `CONTENT_MAX_ATTEMPTS` | `2` | a step that failed or was rejected this often is not retried |
| `CONTENT_VIDEO_MODEL` | Kling | `wan` switches 10 s videos to Wan 3.0 |
| `LLM_JOB_USD` | `0.01` | LLM cost added to each live estimate |
| `X_POSTS_PER_DAY` | `20` | our X posts per UTC day |
| `X_POSTS_PER_TICK` | `2` | spreads the day's posts across ticks |
| `X_POST_USD` | `0.015` | posting cost added to each live estimate when the coin posts to X |
| `X_LINK_REPLY_URL` | empty | e.g. `https://pumpfunads.com/c/{mint}`: replies under each post with the coin link. Off: a URL post costs ~$0.20 |
| `PLANNER_INTERVAL_MIN` | `10` | tick period |
| `PUBLIC_URL` | `https://pumpfunads.com` | OAuth redirect URIs are `<PUBLIC_URL>/api/oauth/<x|tiktok>/callback` |
| `MEDIA_DIR` | `data/media` | next to the DB |
| `ADMIN_TOKEN` | none | at least 16 chars. `/api/admin/login/<token>` sets the `ads_admin` cookie |

Kill switch: kv `content.killed` (admin `POST /api/admin/content/kill {on}`). Per coin: `content_policy` (paused, daily
cap, max per job) via `POST /api/admin/coins/<mint>/policy`. A coin whose own brief fails moderation is paused
automatically, with the reason in `note`.

## Costs per step

Mock mode spends exactly the ladder's figure. Live mode spends Higgsfield's `/estimate` for the exact params + LLM +
one X post, refunds the unused part after the job, and refunds everything on failure or rejection.

| step | what is generated | Higgsfield model (endpoint id) | est. cost |
|---|---|---|---|
| launch_card | 1 square image | `z-image/turbo` 1k | ~$0.01 to $0.02, paid by Ads (`ledger.platform`) |
| meme_pack (Content pack, $3) | 4 square images + captions | `z-image/turbo` 1k x4 | ~$0.15 |
| video (Video content, every $5, at most `VIDEOS_PER_DAY` = 5 a coin a day) | first frame (9:16 image) + 10 s image-to-video | `kling-video/v3.0-turbo/image-to-video` 720p (or `alibaba/wan-3.0/image-to-video`) | ~$0.56 to $0.60 (Kling 3.0 Turbo, 30-50% discount tier) |
| trailer (Bonding campaigns, at bonding) | first frame + 15 s image-to-video in one request | `bytedance/seedance-2.5/image-to-video` 720p | ~$6.95 list, token-priced (~$4.85 with the 30% discount) |
| site (claimed by the launcher after bonding, `POST /api/coins/<mint>/site/claim`, paid by Ads) | 16:9 hero image + page copy | `z-image/turbo` | ~$0.20 incl. Claude |
| Claude | brief + moderation per job | `claude-sonnet-5-5` | ~$0.005 to $0.02 |
| X post | per post without URL | X API pay per use | $0.015 (a post with a URL ~$0.20) |

Sources: docs.higgsfield.ai (endpoint ids, request lifecycle, `/estimate`, idempotency, rate limits; read 10 Oct 2026;
the docs publish no prices), operator's research 10 Oct 2026 for per-second prices (memory `ads-launchpad`), Anthropic
model table (Sonnet 5.5: $2 / $10 per MTok), X API pay-per-use pricing (post $0.015, post with URL $0.20).

## Platform rules we design around

- **No paid promotion of a token.** X Ads and TikTok Ads only allow licensed exchanges and wallets to advertise crypto.
  Our posts promote the coin's story and our page; copy never carries a CA, a price, "buy" or a promise of returns
  (`copy.mjs` rejects them; Claude moderation re-checks). Boosts are manual (admin overview lists coins with balance > $25).
- **TikTok never posts to our own account by API.** The Content Posting API rejects tools posting to team-managed
  accounts and requires the owner to confirm every post. Our TikTok items wait in `GET /api/admin/downloads`; the
  operator uploads them in the TikTok app and marks them `POST /api/admin/posts/<id>/posted {url}`.
- **Creator TikTok = inbox drafts.** `upload to inbox` puts the video in the creator's TikTok inbox; they finish and post
  it. Limits: 6 requests/min per token, at most 5 pending inbox shares per 24 h. An unaudited TikTok app can only reach
  sandbox test users with private posts.
- **X costs per post**, so no links in posts, one post per job (a content pack is one post with 4 images), at most
  `X_POSTS_PER_DAY`, richest coins first. X media upload is the v2 chunked flow (`/2/media/upload/initialize`,
  `/{id}/append`, `/{id}/finalize`, STATUS); the v1.1-style `command=` variants are retired.
- **Creator accounts only after graduation**, only by the launcher wallet, OAuth state single use, 15 min, bound to the
  wallet. Tokens are AES-GCM encrypted under `ADS_MASTER_KEY`.
- Mock media is never posted to a live account.

## Going live (operator)

1. **Higgsfield**: create an API key at console.higgsfield.ai, prepay credits, set `HIGGSFIELD_API_KEY=id:secret`.
   In the console check the account can use `z-image/turbo`, `kling-video/v3.0-turbo/image-to-video` and
   `bytedance/seedance-2.5/image-to-video`, and its concurrency limit (ours runs at most 4 jobs, each sequential).
   Run one estimate per model (`POST https://api.higgsfield.ai/estimate/<endpoint>`) and compare with the ladder.
2. **Claude**: `OPENROUTER_API_KEY` (model `anthropic/claude-sonnet-5.5`, override with `LLM_MODEL`), or `ANTHROPIC_API_KEY` direct.
3. **X (@pumpfunads)**: a developer app at developer.x.com on the @pumpfunads account, pay-per-use credits, app permissions
   Read and Write, generate the Access Token and Secret for @pumpfunads -> the four `X_API_*` / `X_ACCESS_*` vars. For
   creators: enable OAuth 2.0 (Web App, confidential), callback `https://pumpfunads.com/api/oauth/x/callback`, website
   `https://pumpfunads.com` -> `X_CLIENT_ID`, `X_CLIENT_SECRET`.
4. **TikTok**: an app at developers.tiktok.com with Login Kit (redirect `https://pumpfunads.com/api/oauth/tiktok/callback`)
   and Content Posting API (inbox upload), scopes `user.info.basic`, `video.upload`. Submit it for audit; until
   approved only sandbox test users can link. Set `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
5. `ADMIN_TOKEN` (random, 32+ chars). Open `https://pumpfunads.com/api/admin/login/<token>` once per browser.
6. Keep `AUTO_APPROVE=0` until the output is trusted. Turn mocks off adapter by adapter (`MOCK_X=0` etc.); the admin
   overview shows each adapter's mode.

## HTTP

Public: `GET /api/feed?before=&limit=&mint=` -> `{ items, next }`; `GET /api/media/<mint>/<file>` (immutable, byte
ranges); `GET /api/coins/<mint>/content` -> `{ gallery, ladder, socials, site }`.
Launcher: `GET /api/coins/<mint>/socials/<x|tiktok>/connect` (302), `GET /api/oauth/<platform>/callback`,
`DELETE /api/coins/<mint>/socials/<platform>`. Errors on these navigations redirect to `/coin/<mint>?social=..&error=..`; success to `/coin/<mint>?social=<p>&linked=1`.
Admin (cookie, 401 without it): `GET /api/admin/login/<token>` (302 /admin), `GET /api/admin/review` -> `{ items }` (one per
job), `POST /api/admin/review/<id>/approve`, `POST /api/admin/review/<id>/reject {reason}`, `GET /api/admin/tiktok` ->
`{ items }` (id = post id, url = file to download), `POST /api/admin/tiktok/<id>/posted {url}`, `GET /api/admin/overview`
(flat), `GET /api/admin/decisions?mint=`. Aliases: `/api/admin/queue|jobs?status=`, `/api/admin/jobs/<id>/approve|reject`,
`/api/admin/downloads`, `/api/admin/posts/<id>/posted`. Also `POST /api/admin/content/kill {on}`, `POST /api/admin/content/tick`,
`POST /api/admin/coins/<mint>/policy {dailyCapUsd, maxJobUsd, paused, note}`.
