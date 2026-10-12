import { useEffect, useRef, useState } from 'react';
import { Link } from '../lib/router.js';
import { useWallet } from '../lib/wallet.jsx';
import { copy, toast, useToastHost, PLATFORM } from '../lib/data.js';
import { short, usd, money } from '../lib/format.js';
import { STEPS, VIDEO_EVERY_USD } from '../lib/ladder.js';
import { IWallet, IClose, IPlay, IX, ITikTok, ICheck, ILock, ICopy } from './Icons.jsx';

/** The mark: the Ads logo (brand/logo.png, rendered to web/public/mark.png by brand/make-icons.sh). */
export function Mark({ size = 28 }) {
  return <img src="/mark.png?v=5" width={size} height={size} alt="" aria-hidden="true" className="mark" />;
}
export function Brand() {
  return <Link href="/" className="brand" aria-label="Pumpfun Ads home"><Mark size={44} /></Link>;
}

/** IPFS gateways that serve Pumpfun CIDs, in order (ipfs.io and dweb.link refuse many). */
const GATEWAYS = ['https://pump.mypinata.cloud/ipfs', 'https://gateway.pinata.cloud/ipfs', 'https://ipfs.filebase.io/ipfs'];
function logoCandidates(src) {
  if (!src) return [];
  const m = String(src).match(/\/ipfs\/([A-Za-z0-9][A-Za-z0-9._\-/]*)/);
  if (!m) return [src];
  const cid = m[1].replace(/[?#].*$/, '');
  return [...new Set([src, ...GATEWAYS.map((g) => `${g}/${cid}`)])];
}
/** A coin's logo on a rounded tile, trying each gateway, or its first letters when none serves it. */
export function TokenIcon({ src, label = '', size = 40, radius }) {
  const candidates = logoCandidates(src);
  const [i, setI] = useState(0);
  useEffect(() => { setI(0); }, [src]);
  const style = { width: size, height: size, borderRadius: radius ?? Math.round(size * 0.28) };
  // ⛔ `label` can arrive null: a null.slice here once blanked a whole site.
  if (i >= candidates.length) return <span className="token-ico ph" style={{ ...style, fontSize: Math.max(10, size / 3.2) }}>{String(label || '?').slice(0, 3).toUpperCase()}</span>;
  return <img className="token-ico" src={candidates[i]} alt="" loading="lazy" onError={() => setI((x) => x + 1)} style={style} />;
}

export function Progress({ value, graduated }) {
  const pct = graduated ? 100 : Math.max(0, Math.min(100, Math.round((value || 0) * 100)));
  return <div className={`progress ${graduated ? 'grad' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(pct, 2)}%` }} /></div>;
}

/** The curve in words. `phase` is null when the chain could not be read. */
export const phaseText = (c) => (c.phase === 'graduated' ? 'Graduated' : c.phase == null && c.progress == null ? 'Curve status updating' : `${Math.round((c.progress || 0) * 100)}% to bonding`);

export function CoinCard({ c }) {
  const grad = c.phase === 'graduated';
  return (
    <Link href={`/t/${c.mint}`} className="card coin-card min0">
      <div className="row" style={{ gap: 14 }}>
        <TokenIcon src={c.image} label={c.symbol} size={56} />
        <div className="min0">
          <div className="coin-name">{c.name}</div>
          <div className="sym">${c.symbol}</div>
        </div>
        {grad && <span className="badge green" style={{ marginLeft: 'auto' }}>Graduated</span>}
      </div>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div className="coin-cap"><span className="mono">{usd(c.marketCapUsd)}</span><small>market cap</small></div>
        {c.feesUsd != null && <div className="coin-cap"><span className="mono small-fig">{usd(c.feesUsd)}</span><small>fees</small></div>}
      </div>
      <Progress value={c.progress} graduated={grad} />
      <div className="small muted" style={{ marginTop: 10 }}>{phaseText(c)}</div>
    </Link>
  );
}

/** How to draw an item: by its `mime` when the API sends one (a mock "video" can be an SVG image), else by `kind`. */
export function mediaKind(item) {
  const m = String(item.mime || '');
  if (m.startsWith('video/')) return item.url ? 'video' : 'image';
  if (m.startsWith('image/')) return 'image';
  return item.kind === 'video' && item.url ? 'video' : 'image';
}

/** One piece of content: an image, or a video that plays muted while on screen (and on hover). */
export function Media({ item, controls = false, className = '' }) {
  const ref = useRef(null);
  const isVideo = mediaKind(item) === 'video';
  useEffect(() => {
    const v = ref.current;
    if (!isVideo || !v || controls || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && e.intersectionRatio > 0.6) v.play().catch(() => {});
      else v.pause();
    }, { threshold: [0, 0.6, 1] });
    io.observe(v);
    return () => { io.disconnect(); };
  }, [isVideo, controls]);
  return (
    <div className={`media-wrap ${className}`}>
      {isVideo ? (
        <video ref={ref} className="media" src={item.url} poster={item.thumb || undefined} muted loop playsInline preload="metadata" controls={controls}
          onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }} />
      ) : (
        <img className="media" src={item.url || item.thumb} alt={item.caption || ''} loading="lazy" />
      )}
      {!isVideo && item.kind === 'video' && <span className="play-badge"><IPlay size={18} /></span>}
      {item.mock && <span className="sample-tag">sample</span>}
    </div>
  );
}

export const PlatformIcon = ({ p, size = 13 }) => (p === 'tiktok' ? <ITikTok size={size} /> : <IX size={size} />);
export function PostedTo({ list }) {
  if (!list?.length) return null;
  return (
    <span className="posted">
      {list.map((x) => <a key={x.platform + x.url} href={x.url} target="_blank" rel="noreferrer" title={`On ${PLATFORM[x.platform] || x.platform}`} onClick={(e) => e.stopPropagation()}><PlatformIcon p={x.platform} /></a>)}
    </span>
  );
}

/**
 * The marketing plan: one row per ladder step. `rows`: [{ key, label, state, atUsd }]; `note(step)` adds a right
 * hand line (the launch form uses it for the volume each step needs).
 */
export function LadderList({ rows, note, compact = false }) {
  return (
    <ol className={`ladder ${compact ? 'compact' : ''}`}>
      {rows.map((r) => {
        const s = STEPS.find((x) => x.key === r.key) || {};
        return (
          <li key={r.key} className={r.state || 'locked'}>
            <span className="ladder-dot">{r.state === 'done' ? <ICheck size={13} /> : r.state === 'locked' ? <ILock size={11} /> : <i />}</span>
            <div className="min0">
              <div className="ladder-title">{r.label || s.label}</div>
              {!compact && (r.detail || s.detail) && <div className="small muted">{r.detail || s.detail}{r.made > 1 ? ` · ${r.made} made` : ''}</div>}
            </div>
            <div className="ladder-note">{note ? note(r, s) : r.atUsd == null ? (s.onGraduation ? 'at bonding' : '') : r.atUsd === 0 ? 'at launch' : s.key === 'video' ? `every ${money(VIDEO_EVERY_USD)}` : `at ${money(r.atUsd)}`}</div>
          </li>
        );
      })}
    </ol>
  );
}

export function CopyCA({ mint, label = 'CA' }) {
  return <button type="button" className="ca" onClick={() => copy(mint, 'Address copied')} title="Copy the address"><span className="muted">{label}</span> {short(mint, 5)} <ICopy size={13} /></button>;
}

export const Loading = ({ label = 'Loading' }) => <div className="state"><span className="spinner" aria-label={label} /></div>;
export function ErrorState({ error, retry, title = 'Could not load this' }) {
  return (
    <div className="card state">
      <b>{title}</b>
      <span className="muted small">{error?.message || 'The server did not answer.'}</span>
      {retry && <button className="btn sm" onClick={retry}>Try again</button>}
    </div>
  );
}
// One paragraph inside: .state is a flex column, so loose text + a link + "." would each become their own line.
export const Empty = ({ children }) => <div className="card state muted"><p>{children}</p></div>;

export function WalletButton({ big = false }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  // A phone has no mouseleave: a tap anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => { document.removeEventListener('pointerdown', away); };
  }, [open]);
  if (w.signedIn) {
    return (
      <span className="wallet-wrap" ref={wrap}>
        <button className={`btn ${big ? 'lg' : ''} mono`} onClick={() => setOpen((o) => !o)}><span className="dot" />{short(w.session)}</button>
        {open && (
          <div className="menu" onMouseLeave={() => setOpen(false)}>
            <button onClick={() => { copy(w.session, 'Address copied'); setOpen(false); }}>Copy address</button>
            <Link href="/mine" onClick={() => setOpen(false)}>My coins</Link>
            <button onClick={() => { w.disconnect(); setOpen(false); }}>Sign out</button>
          </div>
        )}
      </span>
    );
  }
  return (
    <button className={`btn ${big ? 'lg primary' : ''}`} disabled={w.busy} onClick={() => w.signIn().catch((e) => toast(e.code === 4001 || /reject|cancel|closed/i.test(e.message || '') ? 'Sign-in cancelled' : `Sign-in failed: ${e.message}`, 4500))}>
      <IWallet size={15} /><span>{w.busy ? 'Check your wallet' : w.address ? 'Sign in' : 'Connect Wallet'}</span>
    </button>
  );
}

export function WalletPicker() {
  const w = useWallet();
  useEffect(() => {
    if (!w.picker) return;
    const esc = (e) => { if (e.key === 'Escape') w.closePicker(); };
    addEventListener('keydown', esc);
    return () => { removeEventListener('keydown', esc); };
  }, [w.picker, w.closePicker]);
  if (!w.picker) return null;
  return (
    <div className="overlay" onClick={w.closePicker}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h3>Connect a wallet</h3><button className="icon-btn" aria-label="Close" onClick={w.closePicker}><IClose /></button></div>
        <p className="muted small">Signing in proves you own the wallet. Nothing moves until you approve a transaction.</p>
        {w.providers.length === 0 ? <p className="muted">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p> : (
          <div className="wallet-list">
            {w.providers.map((p) => <button key={p.name} className="wallet-row" disabled={w.busy} onClick={() => w.connectWith(p).catch(() => {})}><img src={p.icon} alt="" width={28} height={28} /> {p.name}</button>)}
          </div>
        )}
        {w.error && <div className="notice bad" style={{ marginTop: 12 }}>{w.error}</div>}
      </div>
    </div>
  );
}

export function Toast() {
  const msg = useToastHost();
  return msg ? <div className="toast">{msg}</div> : null;
}
