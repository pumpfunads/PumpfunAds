/**
 * Higgsfield, pay as you go (docs.higgsfield.ai, read 10 Oct 2026). Every model is one async REST call:
 *   POST {base}/{endpoint}            JSON params  -> { status:'queued', request_id, status_url, cancel_url }
 *   GET  {base}/requests/{id}/status               -> queued | in_progress | completed | failed | nsfw | canceled
 *        completed: images:[{url}] (image models) or video:{url} (video models)
 *   POST {base}/estimate/{endpoint}   same params  -> { credits, usd }
 *   Auth: `Authorization: Key <key_id>:<key_secret>` (HIGGSFIELD_API_KEY holds "id:secret").
 * Failed and nsfw requests are not charged (reserved credits come back). Outputs are kept >= 7 days, so we download
 * every result at once. Concurrency is per account (docs example says 4, the console shows ours; a 400 "Maximum number
 * of concurrent requests" is retried after a pause). Our own cap is GENERATION_CONCURRENCY jobs, each sequential.
 * ⛔ Every submit carries an Idempotency-Key derived from job+shot, so re-running a job after a crash or a timeout
 *    picks up the SAME request instead of paying twice.
 * ⛔ Never log the key: errors carry the endpoint and status only.
 * Webhooks (`?hf_webhook=`) exist; we poll instead (2 s doubling to 10 s, per the docs) so nothing needs a public
 * inbound endpoint and a restart simply resumes.
 */
import { C } from './config.mjs';
import * as credits from './credits.mjs';
import * as media from './media.mjs';

/**
 * The model ids, in one place. Endpoint ids are exact from the docs (10 Oct 2026). Prices are NOT in the docs: the
 * live path asks /estimate before spending; `mockUsd` is only the mock-mode figure (operator's research, 10 Oct).
 * ⛔ VERIFY on the console before going live: that the account has access to each endpoint (404/423/503 otherwise),
 *    and the real /estimate figure for the default params below.
 */
export const MODELS = {
  // cheapest decent text-to-image; 1k, 10 aspect ratios incl. 9:16
  image: { endpoint: 'z-image/turbo', params: { resolution: '1k' } },
  // the alternative: Higgsfield's own SOUL V2 (portraits/fashion look), 720p
  imageSoul: { endpoint: 'higgsfield-ai/soul/v2/standard', params: { resolution: '720p', batch_size: 1 } },
  // 10 s vertical video: Kling 3.0 Turbo image-to-video (3..15 s, 720p/1080p, framing follows the first frame, no sound)
  video: { endpoint: 'kling-video/v3.0-turbo/image-to-video', params: { resolution: '720p' }, seconds: 10 },
  // fallback when there is no first frame: Kling 3.0 Turbo text-to-video (aspect 9:16 allowed)
  videoText: { endpoint: 'kling-video/v3.0-turbo/text-to-video', params: { resolution: '720p', aspect_ratio: '9:16' }, seconds: 10 },
  // 15 s trailer in ONE request: Seedance 2.5 image-to-video (4..30 s, generates audio). Token-priced: 15 s at 720p is
  // ~$6.94 list (~$4.85 with the 30% discount); 30 s at 720p would be ~$13.87 list, over MAX_JOB_USD (operator chose 15 s, 10 Oct).
  trailer: { endpoint: 'bytedance/seedance-2.5/image-to-video', params: { resolution: '720p', generate_audio: true }, seconds: 15 },
  // cheaper video option: Wan 3.0 image-to-video (2..30 s, audio), set CONTENT_VIDEO_MODEL=wan to use it
  videoWan: { endpoint: 'alibaba/wan-3.0/image-to-video', params: { resolution: '720p', aspect_ratio: '9:16', generate_audio: true }, seconds: 10 },
};
const videoModel = () => (process.env.CONTENT_VIDEO_MODEL === 'wan' ? MODELS.videoWan : MODELS.video);

/** Test hook: the next n mock generations fail (a provider 'failed'). */
export const testing = { failNext: 0 };

const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, urlOrPath, body, { idem } = {}) {
  const url = urlOrPath.startsWith('https://') ? urlOrPath : `${C.higgsfield.base}/${urlOrPath.replace(/^\/+/, '')}`;
  const headers = { authorization: `Key ${C.higgsfield.key}`, accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (idem) headers['idempotency-key'] = idem;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const detail = typeof json?.detail === 'string' ? json.detail : JSON.stringify(json?.detail ?? text.slice(0, 200));
    const e = new Error(`higgsfield ${method} ${new URL(url).pathname} ${res.status}: ${detail}`);
    e.status = res.status;
    if (credits.isCreditError(e)) { e.noCredit = true; credits.outOfCredits(e.message); }
    e.busy = res.status === 400 && /concurrent/i.test(detail);
    throw e;
  }
  return json;
}

const estimates = new Map(); // endpoint + params without prompt/urls -> { micros, at }
/** USD micros one request will cost. Live: /estimate (cached 6 h per shape: the prompt does not change the price). */
/**
 * Seedance pricing: billable tokens = ceil(height × width × seconds × 24 / 1024); $0.0214 per 1,000 at 480p/720p,
 * $0.0234 at 1080p. Vertical 9:16 output (480p = 480×854, 720p = 720×1280, 1080p = 1080×1920).
 */
export function tokenPriceUsd(model, p) {
  const res = String(p.resolution || '720p');
  const short = Number.parseInt(res, 10) || 720;
  const long = Math.round((short * 16) / 9);
  const seconds = Number(p.duration || model.seconds || 10);
  const tokens = Math.ceil((short * long * seconds * 24) / 1024);
  return (tokens / 1000) * (short >= 1080 ? 0.0234 : 0.0214);
}

export async function estimate(model, params = {}) {
  const p = { ...model.params, ...params };
  const shape = Object.fromEntries(Object.entries(p).filter(([k]) => !/prompt|url/i.test(k)).sort());
  const key = `${model.endpoint} ${JSON.stringify(shape)}`;
  const hit = estimates.get(key);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.micros;
  const r = await call('POST', `estimate/${model.endpoint}`, { prompt: 'estimate', ...(p.image_url === undefined && /image-to-video/.test(model.endpoint) ? { image_url: 'https://pumpfunads.com/og.png' } : {}), ...p });
  // Token-priced models (Seedance) answer with a description, not a number: priced here from Higgsfield's own formula
  // (read 10 Oct 2026), at LIST price, which is above any discount, so caps stay on the safe side.
  const micros = Math.round((r?.type === 'description' ? tokenPriceUsd(model, p) : Number(r?.usd)) * 1e6);
  if (!Number.isFinite(micros) || micros <= 0) throw new Error(`higgsfield estimate for ${model.endpoint} unreadable`);
  estimates.set(key, { micros, at: Date.now() });
  return micros;
}

/** Submits (idempotent) and polls to a terminal state. Returns the completed status JSON. */
export async function run(model, params, idem, { timeoutMs = 20 * 60_000 } = {}) {
  const body = { ...model.params, ...params };
  let sub;
  for (let tries = 0; ; tries++) {
    try { sub = await call('POST', model.endpoint, body, { idem }); break; } catch (e) {
      // busy (account concurrency) or a 5xx: same idempotency key, so retrying is safe
      if ((e.busy || e.status >= 500 || !e.status) && tries < 8) { await sleep(5_000 * (tries + 1)); continue; }
      throw e;
    }
  }
  return poll(sub.status_url || `requests/${sub.request_id}/status`, { timeoutMs, requestId: sub.request_id });
}

export async function poll(statusUrl, { timeoutMs, requestId }) {
  const deadline = Date.now() + timeoutMs;
  let delay = 2000;
  for (;;) {
    let st;
    try { st = await call('GET', statusUrl); } catch (e) {
      if (e.status === 401 || e.status === 404) throw e;
      st = null; // network or 5xx: keep polling
    }
    if (st && TERMINAL.has(st.status)) {
      if (st.status !== 'completed') throw Object.assign(new Error(`higgsfield request ${requestId} ${st.status}${st.error ? `: ${st.error}` : ''}`), { providerStatus: st.status });
      return { ...st, request_id: st.request_id || requestId };
    }
    if (Date.now() > deadline) throw new Error(`higgsfield request ${requestId} timed out`);
    await sleep(delay + Math.random() * 500);
    delay = Math.min(delay * 1.5, 10_000);
  }
}

function maybeFail() {
  if (testing.failNext > 0) { testing.failNext--; throw Object.assign(new Error('mock generation failed (forced)'), { providerStatus: 'failed' }); }
}

/**
 * One image to disk. Returns { file, mime, width, height, requestId, sourceUrl, mock, costMicros }.
 * `sourceUrl` is the provider's public URL, used as the first frame of a video (no re-upload needed).
 */
export async function image(mint, base, prompt, { aspect = '1:1', idem, title = '', subtitle = '' } = {}) {
  if (C.higgsfield.mock) {
    maybeFail();
    const { svg, w, h } = media.mockSvg({ title, subtitle, prompt, aspect, seed: base });
    return { file: media.writeFile(mint, `${base}.svg`, svg), mime: 'image/svg+xml', width: w, height: h, requestId: null, sourceUrl: null, mock: true, costMicros: 0 };
  }
  const params = { prompt: String(prompt).slice(0, 800), aspect_ratio: aspect };
  const cost = await estimate(MODELS.image, params);
  const out = await run(MODELS.image, params, idem, { timeoutMs: 5 * 60_000 });
  const url = out.images?.[0]?.url;
  if (!url) throw new Error('higgsfield image: completed without an image url');
  credits.recordSpend(cost, `image ${out.request_id}`);
  const d = await media.download(mint, url, base, 'image/jpeg');
  return { file: d.file, mime: d.mime, width: null, height: null, requestId: out.request_id, sourceUrl: url, mock: false, costMicros: cost };
}

/**
 * One video to disk, image-to-video from `imageUrl` (or text-to-video without one). kind 'video' (10 s) | 'trailer' (30 s).
 * Returns { file, mime, duration, requestId, mock, costMicros }.
 */
export async function video(mint, base, prompt, { imageUrl = null, kind = 'video', idem } = {}) {
  const model = kind === 'trailer' ? MODELS.trailer : imageUrl ? videoModel() : MODELS.videoText;
  if (C.higgsfield.mock) {
    maybeFail();
    const file = await media.mockMp4(mint, `${base}.mp4`);
    return { file, mime: file ? 'video/mp4' : null, duration: file ? 1 : model.seconds, requestId: null, mock: true, costMicros: 0 };
  }
  const params = { prompt: String(prompt).slice(0, 2000), duration: model.seconds, ...(imageUrl ? { image_url: imageUrl } : {}) };
  const cost = await estimate(model, params);
  const out = await run(model, params, idem, { timeoutMs: (kind === 'trailer' ? 45 : 25) * 60_000 });
  const url = out.video?.url;
  if (!url) throw new Error('higgsfield video: completed without a video url');
  credits.recordSpend(cost, `${kind} ${out.request_id}`);
  const d = await media.download(mint, url, base, 'video/mp4');
  return { file: d.file, mime: d.mime, duration: model.seconds, requestId: out.request_id, mock: false, costMicros: cost };
}

/** What one ladder step costs at Higgsfield (USD micros), before LLM and posting. Live: from /estimate. */
export async function estimateStep(step) {
  const img = (aspect) => estimate(MODELS.image, { aspect_ratio: aspect });
  switch (step) {
    case 'launch_card': return img('1:1');
    case 'meme_pack': return 4 * (await img('1:1'));
    case 'video': return (await img('9:16')) + (await estimate(videoModel(), { duration: videoModel().seconds }));
    case 'trailer': return (await img('9:16')) + (await estimate(MODELS.trailer, { duration: MODELS.trailer.seconds }));
    case 'site': return img('16:9');
    default: throw new Error(`no estimate for step ${step}`);
  }
}
