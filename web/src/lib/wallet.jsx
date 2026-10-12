/**
 * Solana wallet connection and sign-in.
 *
 * ⛔ Wallets are found through Wallet Standard (Phantom, Solflare, Backpack and the rest announce
 *    themselves), never a `window.solana` global: with two extensions installed the global is
 *    whichever loaded last, which picks a wallet FOR the user.
 * ⭐ Signing proves ownership only. The session cookie is bound to the wallet that signed; if the
 *    extension switches account, the session is dropped.
 * ⛔ Base58 is case-sensitive: addresses are compared exactly, never lowercased.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import bs58 from 'bs58';
import { api } from './api.js';

const Ctx = createContext(null);
export const useWallet = () => useContext(Ctx);

const usable = (w) => Boolean(w.features['standard:connect'] && w.features['solana:signMessage'] && (w.chains || []).some((c) => c.startsWith('solana:')));

const LAST = 'ads:last-wallet';
const store = {
  get: () => {
    try {
      return localStorage.getItem(LAST);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      v ? localStorage.setItem(LAST, v) : localStorage.removeItem(LAST);
    } catch {}
  },
};

const cancelled = (e) => e?.code === 4001 || /reject|cancel|denied|closed/i.test(e?.message || '');

export function WalletProvider({ children }) {
  const [providers, setProviders] = useState([]);
  const [active, setActive] = useState(null); // Wallet Standard wallet
  const [account, setAccount] = useState(null); // WalletAccount
  const [session, setSession] = useState(undefined); // undefined = loading, null = none
  const [access, setAccess] = useState(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(null);
  // ⛔ The LIVE connection, mirrored into a ref: a caller holding this context from an earlier render (Launch's go():
  // signIn, then signTransactions) must see the wallet signIn just connected, or connect() opens the picker again.
  const live = useRef({ active: null, account: null, session: undefined });
  const putActive = (v) => { live.current.active = v; setActive(v); };
  const putAccount = (v) => { live.current.account = v; setAccount(v); };
  const putSession = (v) => { live.current.session = v; setSession(v); };
  const address = account?.address || null;

  useEffect(() => {
    const reg = getWallets();
    const sync = () => setProviders(reg.get().filter(usable));
    sync();
    const offs = [reg.on('register', sync), reg.on('unregister', sync)];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    api.session().then((s) => putSession(s.wallet || null)).catch(() => putSession(null));
  }, []);

  // Quietly reattach the last wallet the user picked, without a prompt.
  useEffect(() => {
    if (active) return;
    const name = store.get();
    const w = name && providers.find((x) => x.name === name);
    if (!w) return;
    w.features['standard:connect'].connect({ silent: true }).then(({ accounts }) => {
      if (accounts?.[0]) {
        putActive(w);
        putAccount(accounts[0]);
      }
    }).catch(() => {});
  }, [providers, active]);

  useEffect(() => {
    const ev = active?.features['standard:events'];
    if (!ev) return;
    return ev.on('change', ({ accounts }) => {
      if (accounts) putAccount(accounts[0] || null);
    });
  }, [active]);

  // The connected wallet is the one we measure. A session for any other address is dropped.
  useEffect(() => {
    if (session && address && session !== address) {
      api.signOut().catch(() => {});
      putSession(null);
      setAccess(null);
    }
  }, [session, address]);

  const refreshAccess = useCallback(async () => {}, []);

  const connectWith = useCallback(async (w) => {
    setError(null);
    setBusy(true);
    try {
      const { accounts } = await w.features['standard:connect'].connect();
      const acct = accounts?.[0];
      if (!acct) throw new Error('The wallet returned no account.');
      putActive(w);
      putAccount(acct);
      store.set(w.name);
      setPicker(false);
      pending.current?.resolve({ w, acct });
      return { w, acct };
    } catch (e) {
      setError(cancelled(e) ? 'Connection was cancelled in the wallet.' : e.message);
      pending.current?.reject(e);
      throw e;
    } finally {
      pending.current = null;
      setBusy(false);
    }
  }, []);

  const connect = useCallback(() => {
    const { active: a, account: acc } = live.current;
    if (a && acc) return Promise.resolve({ w: a, acct: acc });
    setPicker(true);
    return new Promise((resolve, reject) => {
      pending.current = { resolve, reject };
    });
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    const { w, acct } = await connect();
    setBusy(true);
    try {
      const n = await api.nonce();
      const message = new TextEncoder().encode(n.template.replace('YOUR_WALLET', acct.address));
      const [out] = await w.features['solana:signMessage'].signMessage({ account: acct, message });
      const s = await api.signIn({ wallet: acct.address, nonce: n.nonce, signature: bs58.encode(out.signature) });
      putSession(s.wallet);
      return s.wallet;
    } catch (e) {
      setError(cancelled(e) ? 'Signing was cancelled in the wallet.' : e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [connect]);

  /**
   * Signs base64 transactions with the connected wallet in ONE prompt (Wallet Standard
   * solana:signTransaction takes several inputs). Returns them signed, base64, in order.
   */
  const signTransactions = useCallback(async (b64s) => {
    const { w, acct } = await connect();
    const session = live.current.session;
    // The launch was prepared for the signed-in wallet (it pays the fees): a different account would
    // only produce a transaction the server refuses.
    if (session && acct.address !== session) throw new Error(`Your wallet is on ${acct.address.slice(0, 4)}…${acct.address.slice(-4)}, but you signed in as ${session.slice(0, 4)}…${session.slice(-4)}. Switch accounts, or sign in again.`);
    const f = w.features['solana:signTransaction'];
    if (!f) throw new Error('This wallet cannot sign transactions here. Try Phantom, Solflare or Backpack.');
    const inputs = b64s.map((b) => ({ account: acct, transaction: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), chain: 'solana:mainnet' }));
    const out = await f.signTransaction(...inputs);
    return out.map((o) => btoa(String.fromCharCode(...o.signedTransaction)));
  }, [connect]);

  const disconnect = useCallback(async () => {
    await api.signOut().catch(() => {});
    putSession(null);
    setAccess(null);
    putAccount(null);
    putActive(null);
    store.set(null);
    try {
      await active?.features['standard:disconnect']?.disconnect();
    } catch {}
  }, [active]);

  const closePicker = useCallback(() => {
    setPicker(false);
    pending.current?.reject(Object.assign(new Error('closed'), { code: 4001 }));
    pending.current = null;
  }, []);

  const value = useMemo(() => ({
    providers, address, session, access, busy, error, picker,
    signedIn: Boolean(session && (!address || session === address)),
    connect, connectWith, signIn, disconnect, refreshAccess, closePicker, setError, signTransactions,
  }), [providers, address, session, access, busy, error, picker, connect, connectWith, signIn, disconnect, refreshAccess, closePicker, signTransactions]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
