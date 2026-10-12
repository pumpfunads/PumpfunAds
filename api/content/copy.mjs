/**
 * The copy rules every caption passes before it can be posted, applied locally (always) and again by the LLM moderator
 * (when live). Operator rules: no emojis, no hashtags, no `--` (or em dashes), say "Pumpfun" not "pump.fun".
 * Platform rules: never a contract address, a price, "buy" or a promise of returns in OUR ad copy (X and TikTok both
 * forbid promoting a token; we post content about a coin's story, never a call to trade it).
 */

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/** Rewrites what can be fixed silently (style), leaves meaning alone. */
export function clean(text) {
  return String(text ?? '')
    .replace(EMOJI, '')
    .replace(/pump\.fun/gi, 'Pumpfun')
    .replace(/(^|\s)#(\w+)/g, '$1$2') // a hashtag becomes the plain word
    .replace(/(^|\s)\$([A-Za-z][A-Za-z0-9]{0,11})\b/g, '$1$2') // a cashtag too
    .replace(/\s*(--+|—|–)\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

// What can NOT be fixed by rewriting: the caption is rejected (and regenerated or refunded).
const BLOCKED = [
  [/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/, 'contract address'],
  [/\b0x[0-9a-fA-F]{40}\b/, 'contract address'],
  [/contract address|\bCA\b/, 'contract address'],
  [/\b(buy|buying|bought|ape in|aping|snipe)\b/i, 'trade call'],
  [/\$\s?\d|\d\s?(usd|sol)\b|\bprice\b|market ?cap|\bmcap\b/i, 'price'],
  [/\b\d{2,}\s?x\b|\bmooning\b|to the moon|guarantee|profit|\breturns on\b|get rich|financial advice|\bnfa\b|\bdyor\b/i, 'promise of returns'],
  [/https?:\/\/|www\.|\.(com|io|app|xyz|fun)\b/i, 'link'],
];

/** { ok, reasons[] } for a cleaned caption. */
export function check(text) {
  const reasons = [];
  for (const [re, why] of BLOCKED) if (re.test(text) && !reasons.includes(why)) reasons.push(why);
  if (!text.trim()) reasons.push('empty');
  return { ok: reasons.length === 0, reasons };
}

/** The text we post: the caption, cleaned, always naming the coin, within X's 280 characters. */
export function postText(caption, { name, symbol }) {
  let t = clean(caption);
  const lower = t.toLowerCase();
  if (name && !lower.includes(String(name).toLowerCase()) && !(symbol && lower.includes(String(symbol).toLowerCase()))) t = `${name}. ${t}`;
  if (t.length > 280) t = `${t.slice(0, 277).replace(/\s+\S*$/, '')}...`;
  return t;
}
