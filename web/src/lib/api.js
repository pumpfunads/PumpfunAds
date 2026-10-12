/**
 * The HTTP API (SPEC.md "HTTP API (front end contract)").
 *
 * Dev-only mock: `npm run dev:web`, then open http://localhost:5421/?mock. Every call is answered by ./mock.js with
 * sample data, so the design can be reviewed before the API answers. The choice sticks for the tab (sessionStorage);
 * `?mock=off` turns it off. In a production build `import.meta.env.DEV` is false, so the mock and its import are dropped.
 */
function mockOn() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('mock')) q.get('mock') === 'off' ? sessionStorage.removeItem('ads:mock') : sessionStorage.setItem('ads:mock', '1');
    return sessionStorage.getItem('ads:mock') === '1';
  } catch {
    return false;
  }
}
export const isMock = import.meta.env.DEV ? mockOn() : false;
let mock = null;

async function req(path, opts = {}) {
  if (import.meta.env.DEV && isMock) {
    mock ??= await import('./mock.js');
    return mock.handle(path, opts);
  }
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...opts });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) throw Object.assign(new Error(body?.error || `Request failed (${r.status})`), { status: r.status, stage: body?.stage ?? null });
  return body;
}
const send = (path, data, method = 'POST') => req(path, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
const qs = (o) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  return s ? `?${s}` : '';
};

export const api = {
  config: () => req('/api/config'),
  stats: () => req('/api/stats'),
  feed: ({ before = '', limit = 24 } = {}) => req(`/api/feed${qs({ before, limit })}`),
  coins: ({ sort = 'new', q = '', limit = '', graduated = false, platform = '' } = {}) => req(`/api/coins${qs({ sort, q, limit, graduated: graduated ? 1 : '', platform })}`),
  coin: (mint) => req(`/api/coins/${mint}`),
  mine: () => req('/api/mine'),
  nonce: () => req('/api/nonce'),
  session: () => req('/api/session'),
  signIn: (data) => send('/api/session', data),
  signOut: () => req('/api/session', { method: 'DELETE' }),
  logo: (body) => send('/api/launch/logo', body),
  prepare: (form) => send('/api/launch/prepare', form),
  submit: (mint, transactions) => send('/api/launch/submit', { mint, transactions }),
  relock: (mint) => send('/api/launch/relock', { mint }),
  /** A full page navigation (302 to X / TikTok), not a fetch. */
  socialConnectUrl: (mint, platform) => `/api/coins/${mint}/socials/${platform}/connect`,
  unlinkSocial: (mint, platform) => req(`/api/coins/${mint}/socials/${platform}`, { method: 'DELETE' }),
  claimSite: (mint) => send(`/api/coins/${mint}/site/claim`, {}),
  sendTikTok: (mint, assetId) => send(`/api/coins/${mint}/socials/tiktok/send`, { assetId }),
  admin: {
    loginUrl: (token) => `/api/admin/login/${encodeURIComponent(token)}`,
    overview: () => req('/api/admin/overview'),
    campaigns: () => req('/api/admin/campaigns'),
    adSpend: (mint, usd, note) => send(`/api/admin/coins/${mint}/adspend`, { usd, note }),
    withdraw: () => send('/api/admin/treasury/withdraw', {}),
    review: () => req('/api/admin/review'),
    approve: (id) => send(`/api/admin/review/${id}/approve`, {}),
    reject: (id, reason) => send(`/api/admin/review/${id}/reject`, { reason }),
    tiktok: () => req('/api/admin/tiktok'),
    markPosted: (id, url) => send(`/api/admin/tiktok/${id}/posted`, { url }),
  },
};
