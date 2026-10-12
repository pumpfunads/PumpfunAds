/**
 * Points our posting account at a different X account, keeping the same developer app (X_API_KEY/SECRET).
 * OAuth 1.0a PIN flow (operator 12 Oct: new @pumpfunads account, the app's own token posted as the old @UseAdsApp):
 *   node scripts/x-authorize.mjs start        prints a link: open it LOGGED IN AS THE NEW ACCOUNT, approve, X shows a PIN
 *   node scripts/x-authorize.mjs <PIN>        swaps the PIN for that account's token, writes X_ACCESS_TOKEN/SECRET into
 *                                             .env (never printed), and reports which account it now posts as
 * The request token waits in data/x-request-token.json between the two steps (deleted after; it expires in minutes).
 */
import './../api/env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { oauth1Header } from '../api/content/x.mjs';

const STATE = new URL('../data/x-request-token.json', import.meta.url);
const ENV = new URL('../.env', import.meta.url);
const ck = process.env.X_API_KEY, cs = process.env.X_API_SECRET;
if (!ck || !cs) throw new Error('X_API_KEY / X_API_SECRET missing in .env');

const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Signs with extra oauth_* params (oauth_callback, oauth_verifier) that the posting signer does not take. */
function header(method, url, extra, token = '', tokenSecret = '') {
  const oauth = { oauth_consumer_key: ck, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: '1.0', ...(token ? { oauth_token: token } : {}), ...extra };
  const params = Object.entries(oauth).map(([k, v]) => [pct(k), pct(v)]).sort(([a], [b]) => (a < b ? -1 : 1));
  const base = [method, pct(url), pct(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const sig = crypto.createHmac('sha1', `${pct(cs)}&${pct(tokenSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}
async function post(url, auth) {
  const r = await fetch(url, { method: 'POST', headers: { authorization: auth } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).pathname} ${r.status}: ${text.slice(0, 200)}`);
  return Object.fromEntries(new URLSearchParams(text));
}

const arg = process.argv[2];
if (arg === 'start') {
  const url = 'https://api.x.com/oauth/request_token';
  const t = await post(url, header('POST', url, { oauth_callback: 'oob' }));
  if (t.oauth_callback_confirmed !== 'true') throw new Error('X did not confirm the PIN flow');
  fs.writeFileSync(STATE, JSON.stringify({ token: t.oauth_token, secret: t.oauth_token_secret, at: Date.now() }), { mode: 0o600 });
  console.log(`Open this link while logged in to X as the NEW account, press Authorize app, copy the PIN:\nhttps://api.x.com/oauth/authorize?oauth_token=${t.oauth_token}`);
} else if (/^\d{4,10}$/.test(arg || '')) {
  if (!fs.existsSync(STATE)) throw new Error('run `start` first');
  const rt = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const url = 'https://api.x.com/oauth/access_token';
  const a = await post(url, header('POST', url, { oauth_verifier: arg }, rt.token, rt.secret));
  if (!a.oauth_token || !a.oauth_token_secret) throw new Error('X returned no access token');
  // Prove the token works BEFORE it replaces the old one.
  const me = 'https://api.x.com/2/users/me';
  const r = await fetch(me, { headers: { authorization: oauth1Header('GET', me, { consumerKey: ck, consumerSecret: cs, token: a.oauth_token, tokenSecret: a.oauth_token_secret }) } });
  const who = (await r.json())?.data;
  if (!r.ok || !who?.username) throw new Error(`the new token does not read its account (${r.status}); .env unchanged`);
  let env = fs.readFileSync(ENV, 'utf8');
  for (const [k, v] of [['X_ACCESS_TOKEN', a.oauth_token], ['X_ACCESS_SECRET', a.oauth_token_secret]]) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(ENV, env);
  const check = fs.readFileSync(ENV, 'utf8');
  if (!check.includes(`X_ACCESS_TOKEN=${a.oauth_token}`) || !check.includes(`X_ACCESS_SECRET=${a.oauth_token_secret}`)) throw new Error('.env write did not stick');
  fs.unlinkSync(STATE);
  console.log(`X_ACCESS_TOKEN/SECRET written: we now post as @${who.username} (id ${who.id}). Restart the service to use it.`);
} else {
  console.log('usage: node scripts/x-authorize.mjs start | <PIN>');
}
