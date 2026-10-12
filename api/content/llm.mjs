/**
 * Claude (through OpenRouter's chat completions API, or the Anthropic Messages API directly; plain fetch): the creative brief for each ladder step and the moderation of every
 * brief, prompt and caption. JSON comes back through structured outputs (`output_config.format` json_schema), so a reply
 * either matches the schema or the call fails; no parsing of prose.
 * ⛔ claude-sonnet-5-5 rejects forced tool_choice (400) and the old `output_format`; structured outputs is the way.
 * ⛔ stop_reason 'refusal' is an HTTP 200: checked before reading content. Server-side fallbacks are on for the
 *    models that take `fallbacks: "default"`.
 * OpenRouter: the same JSON schema goes as `response_format` json_schema (strict); its cost comes back in usage.cost.
 * Mock (no OPENROUTER_API_KEY / ANTHROPIC_API_KEY, or MOCK_LLM=1): deterministic templates from the coin's own brief, and moderation by the
 * local copy rules only (copy.mjs, which also run in live mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { C } from './config.mjs';
import { clean, check } from './copy.mjs';
import { LOGO_DIR } from '../images.mjs';

const API = 'https://api.anthropic.com/v1/messages';
// $ per million tokens [input, output] (claude-api skill table, cached 6 Oct 2026)
const PRICES = { 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-opus-5-5': [4, 20] };
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

/** How many shots each step makes. A video shot = a first-frame image + a motion prompt. */
export const SHOTS = { launch_card: 1, meme_pack: 4, video: 1, trailer: 1, site: 1 };

const RULES = `Hard rules for every caption and prompt:
- Never write a contract address, a price, a market cap, "buy", "ape", "snipe", or any promise of gains (no "100x", "moon", "profit", "guaranteed").
- No links, no emojis, no hashtags, no cashtags, no "--" and no em dashes.
- Say "Pumpfun", never "pump.fun".
- No real people (no celebrities, politicians, influencers, no likeness of any real person), no other brands, logos or trademarks.
- No slurs, sexual content, violence against people, drugs, or anything hateful.
- Captions tell the coin's story and character; they never ask anyone to trade it.
- Images and videos never show trading: no charts, candles, price graphs, tickers, order books, numbers on screens or coins
  stacked as money. A screen in a scene shows something else (a game, a cartoon, code, a cozy glow, an abstract shape),
  even when the coin's own story is about trading.`;

const SYSTEM = `You are the creative team of Ads (pumpfunads.com), a Pumpfun launchpad that makes marketing content for every coin launched on it: memes, short vertical videos, a trailer and a one page site. You write image prompts, motion prompts and short social captions for one coin at a time, in the coin's own voice, from the creator's brief.
Image prompts are concrete visual descriptions for a text-to-image model (subject, setting, style, lighting, composition), with no text or lettering in the image unless the meme needs one short line. Motion prompts describe camera and subject movement for an image-to-video model starting from that image. Captions are at most 200 characters, punchy, and name the coin.
${RULES}`;

const STEP_ASK = {
  launch_card: 'One launch card: a striking square image introducing the coin and its mascot. motion_prompt empty.',
  meme_pack: 'A pack of 4 memes: 4 different square meme images with a different joke each, each with its own caption. motion_prompt empty.',
  video: 'One 10 second vertical (9:16) video: image_prompt is the first frame, motion_prompt the action across 10 seconds.',
  trailer: 'One 15 second vertical (9:16) trailer for the coin graduating on Pumpfun: image_prompt is the first frame, motion_prompt a cinematic 15 second arc (setup, build, payoff).',
  site: 'A one page site: a wide (16:9) hero image prompt (motion_prompt empty, caption = the page title) plus the site copy.',
};

const shotSchema = { type: 'object', properties: { image_prompt: { type: 'string' }, motion_prompt: { type: 'string' }, caption: { type: 'string' } }, required: ['image_prompt', 'motion_prompt', 'caption'], additionalProperties: false };
const briefSchema = (step) => ({
  type: 'object',
  properties: {
    story: { type: 'string' },
    shots: { type: 'array', items: shotSchema },
    ...(step === 'site' ? { site: { type: 'object', properties: { headline: { type: 'string' }, tagline: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['headline', 'tagline', 'paragraphs'], additionalProperties: false } } : {}),
  },
  required: ['story', 'shots', ...(step === 'site' ? ['site'] : [])],
  additionalProperties: false,
});
const moderationSchema = { type: 'object', properties: { ok: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, reason: { type: 'string' } }, required: ['index', 'reason'], additionalProperties: false } } }, required: ['ok', 'issues'], additionalProperties: false };

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const PRICES_OR = { 'anthropic/claude-sonnet-5.5': [2, 10], 'anthropic/claude-haiku-5.5': [0.1, 0.5], 'anthropic/claude-opus-5.5': [4, 20] };

/** Anthropic content blocks → OpenAI-style parts (text, image as a data URL). */
const toOpenAi = (content) => (typeof content === 'string' ? content : content.map((b) => (b.type === 'image'
  ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
  : { type: 'text', text: b.text })));

async function askOpenRouter({ system, content, schema, maxTokens }) {
  const body = {
    model: C.llm.model, max_tokens: maxTokens, usage: { include: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: toOpenAi(content) }],
    response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } },
  };
  const headers = { authorization: `Bearer ${C.llm.key}`, 'content-type': 'application/json', 'http-referer': 'https://pumpfunads.com', 'x-title': 'Ads' };
  let res;
  for (let tries = 0; ; tries++) {
    res = await fetch(OPENROUTER, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    if ((res.status === 429 || res.status >= 500) && tries < 3) { await new Promise((r) => setTimeout(r, 3000 * (tries + 1))); continue; }
    break;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) throw new Error(`llm ${res.status}: ${json?.error?.message || 'error'}`);
  const choice = json.choices?.[0];
  if (!choice) throw new Error('llm: no reply');
  if (choice.finish_reason === 'length') throw new Error('llm reply cut at max_tokens');
  if (choice.message?.refusal || choice.native_finish_reason === 'refusal') throw Object.assign(new Error('llm refused (policy)'), { refusal: true });
  const text = typeof choice.message?.content === 'string' ? choice.message.content : (choice.message?.content || []).map((p) => p.text || '').join('');
  const [pin, pout] = PRICES_OR[C.llm.model] || [2, 10];
  const costMicros = json.usage?.cost != null ? Math.round(json.usage.cost * 1e6) : Math.round((json.usage?.prompt_tokens || 0) * pin + (json.usage?.completion_tokens || 0) * pout);
  // A model can wrap JSON in a code fence even with a schema: take the outermost object.
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return { data: JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)), costMicros };
}

async function ask({ system, content, schema, maxTokens = 4000 }) {
  if (C.llm.provider === 'openrouter') return askOpenRouter({ system, content, schema, maxTokens });
  const body = { model: C.llm.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], output_config: { effort: 'low', format: { type: 'json_schema', schema } } };
  const headers = { 'x-api-key': C.llm.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (FALLBACK_MODELS.has(C.llm.model)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
  let res;
  for (let tries = 0; ; tries++) {
    res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    if ((res.status === 429 || res.status >= 500) && tries < 3) { await new Promise((r) => setTimeout(r, 3000 * (tries + 1))); continue; }
    break;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`llm ${res.status}: ${json?.error?.message || 'error'}`);
  if (json.stop_reason === 'refusal') throw Object.assign(new Error(`llm refused (${json.stop_details?.category || 'policy'})`), { refusal: true });
  if (json.stop_reason === 'max_tokens') throw new Error('llm reply cut at max_tokens');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const [pin, pout] = PRICES[json.model] || PRICES[C.llm.model] || [2, 10];
  const costMicros = Math.round(((json.usage?.input_tokens || 0) * pin + (json.usage?.output_tokens || 0) * pout));
  return { data: JSON.parse(text), costMicros };
}

function logoBlock(image) {
  try {
    const name = path.basename(String(image || ''));
    const m = name.match(/\.(webp|png|jpe?g|gif)$/i);
    if (!m) return null;
    const p = path.join(LOGO_DIR, name);
    if (!fs.existsSync(p) || fs.statSync(p).size > 4 * 1024 * 1024) return null;
    const type = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[m[1].toLowerCase()];
    return { type: 'image', source: { type: 'base64', media_type: type, data: fs.readFileSync(p).toString('base64') } };
  } catch { return null; }
}

const coinFacts = (coin, brief) => [
  `Coin: ${coin.name} (${coin.symbol})`,
  coin.description ? `Description: ${coin.description}` : null,
  brief.pitch ? `Pitch: ${brief.pitch}` : null,
  Array.isArray(brief.vibe) && brief.vibe.length ? `Vibe: ${brief.vibe.join(', ')}` : null,
  brief.audience ? `Audience: ${brief.audience}` : null,
  brief.mascot ? `Details: ${brief.mascot}` : null,
].filter(Boolean).join('\n');

/**
 * The creative brief for one step: { story, shots:[{ image_prompt, motion_prompt, caption }], site? , costMicros }.
 * `previous` = captions already made for this coin, so a new video does not repeat the last one.
 */
export async function brief(step, coin, coinBrief = {}, { previous = [], seq = 1 } = {}) {
  const n = SHOTS[step];
  if (!n) throw new Error(`no brief for step ${step}`);
  if (C.llm.mock) return { ...mockBrief(step, coin, coinBrief, seq), costMicros: 0, mock: true };
  const logo = logoBlock(coin.image);
  const ref = coinBrief.refImage ? logoBlock(coinBrief.refImage) : null;
  const text = `${coinFacts(coin, coinBrief)}\n\nMake: ${STEP_ASK[step]}${step === 'video' ? ` This is video number ${seq} for this coin.` : ''}\nReturn exactly ${n} shot${n > 1 ? 's' : ''}.${previous.length ? `\nAlready posted (do not repeat these ideas):\n${previous.slice(0, 12).map((c) => `- ${c}`).join('\n')}` : ''}${logo ? '\nThe first attached image is the coin logo: keep the mascot consistent with it, but never reproduce text from it.' : ''}${ref ? '\nThe last attached image is a reference the creator uploaded for the look: follow its subject and style, but never reproduce text, logos or real people from it.' : ''}`;
  const imgs = [logo, ref].filter(Boolean);
  const { data, costMicros } = await ask({ system: SYSTEM, content: imgs.length ? [...imgs, { type: 'text', text }] : text, schema: briefSchema(step) });
  if (!Array.isArray(data.shots) || data.shots.length < n) throw new Error(`llm brief: ${data.shots?.length || 0} shots, wanted ${n}`);
  return { ...data, shots: data.shots.slice(0, n), costMicros, mock: false };
}

/**
 * Moderates texts before anything is generated or posted. items = [{ text, kind:'caption'|'prompt'|'brief' }].
 * The local copy rules (copy.mjs) always run on captions; the LLM reviews every item on top when live.
 * Returns { ok, issues:[{ index, reason }], costMicros }.
 */
export async function moderate(items) {
  const issues = [];
  items.forEach((it, i) => {
    if (it.kind !== 'caption') return; // a prompt may say "price tag"; the LLM judges prompts and briefs
    const r = check(clean(it.text));
    if (!r.ok) issues.push({ index: i, reason: r.reasons.join(', ') });
  });
  if (C.llm.mock || !items.length) return { ok: issues.length === 0, issues, costMicros: 0, mock: C.llm.mock };
  const list = items.map((it, i) => `${i} [${it.kind}]: ${String(it.text).slice(0, 1500)}`).join('\n');
  const { data, costMicros } = await ask({
    system: `You review marketing text for Ads (pumpfunads.com) before it is generated or posted: captions (posted as written), image/video prompts (sent to a generation model) and creators' briefs (what a coin is about). Flag an item when it breaks a rule.\n${RULES}\nAlso flag anything X or TikTok would remove, and anything that promotes trading a token. Be strict about real people and brands, relaxed about harmless jokes.`,
    content: `Review these items (index [kind]: text). Return ok=false and one issue per broken item.\n${list}`,
    schema: moderationSchema, maxTokens: 2000,
  });
  for (const it of data.issues || []) if (Number.isInteger(it.index) && it.index >= 0 && it.index < items.length) issues.push({ index: it.index, reason: String(it.reason).slice(0, 200) });
  return { ok: issues.length === 0 && data.ok !== false, issues, costMicros, mock: false };
}

/* ───────────── mock ───────────── */

const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];
function mockBrief(step, coin, b, seq) {
  const mascot = b.mascot || `${coin.name} mascot`;
  const vibe = (Array.isArray(b.vibe) && b.vibe.length ? b.vibe : ['bold', 'playful']).join(', ');
  const pitch = b.pitch || coin.description || `${coin.name} is here`;
  const jokes = ['when the vibe is a mood', 'me explaining the lore at 3am', 'nobody: absolutely nobody:', 'the group chat at 3am'];
  const shots = Array.from({ length: SHOTS[step] }, (_, i) => ({
    image_prompt: `${mascot}, ${vibe} style, ${step === 'meme_pack' ? pick(jokes, i + seq) : pitch}, clean composition, studio lighting`,
    motion_prompt: step === 'video' || step === 'trailer' ? `slow push in on ${mascot}, it turns to camera, ${step === 'trailer' ? 'builds to a triumphant reveal over 15 seconds' : 'ends on a confident pose'}` : '',
    caption: step === 'meme_pack' ? `${coin.name}: ${pick(jokes, i + seq)}` : step === 'site' ? `${coin.name}` : `${coin.name}. ${pitch}`.slice(0, 200),
  }));
  return {
    story: `${coin.name} (${coin.symbol}): ${pitch}`,
    shots,
    ...(step === 'site' ? { site: { headline: coin.name, tagline: pitch.slice(0, 120), paragraphs: [`${coin.name} started on Pumpfun.`, `The vibe: ${vibe}.`] } } : {}),
  };
}
