import { createContext, useContext, useEffect, useState } from 'react';

/** What the site assumes until GET /api/config answers (and keeps if it never does). */
export const FALLBACK_CONFIG = {
  brand: 'Pumpfun Ads',
  accent: '#86EFAC',
  token: null,
  launchOpen: null,
  feeRates: [0, 30, 100, 200, 300],
  maxDevBuySol: 10,
  vanity: { suffix: 'ads', ready: null },
  platforms: ['x', 'tiktok'],
  socials: { x: '@pumpfunads', tiktok: '@pumpfunad' },
  explorer: 'https://solscan.io',
};
export const ConfigCtx = createContext(FALLBACK_CONFIG);
export const useConfig = () => useContext(ConfigCtx);

/** Polls a loader while mounted. Keeps the last good value through a failed poll. */
export function usePoll(loader, ms, deps = [], { reset = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  // reset: new deps (another coin's page) start empty: never show the previous coin's data, or keep it after a 404.
  const key = JSON.stringify(deps);
  const [seen, setSeen] = useState(key);
  if (seen !== key) { setSeen(key); if (reset) { setData(null); setError(null); } }
  useEffect(() => {
    let alive = true;
    const pull = () => loader().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError(e); });
    pull();
    const t = ms ? setInterval(pull, ms) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [...deps, tick]);
  return [data, error, () => setTick((x) => x + 1)];
}

let toastFn = null;
export const toast = (msg, ms = 1800) => toastFn?.(msg, ms);
export function useToastHost() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    let t = null;
    toastFn = (m, ms) => { setMsg(m); clearTimeout(t); t = setTimeout(() => setMsg(null), ms); };
    return () => { toastFn = null; };
  }, []);
  return msg;
}
export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Copy failed');
  }
}

export const feeLabel = (bps) => (!bps ? 'Standard' : `${bps / 100}%`);
export const PLATFORM = { x: 'X', tiktok: 'TikTok' };
export const pumpUrl = (mint) => `https://pump.fun/coin/${mint}`;
