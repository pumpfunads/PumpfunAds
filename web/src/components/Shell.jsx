import { Link } from '../lib/router.js';
import { useConfig, copy } from '../lib/data.js';
import { short } from '../lib/format.js';
import { Brand, WalletButton } from './ui.jsx';
import { IFeed, IBolt, ICompass, ICoins, IDoc, IX, ITikTok, IGithub, ICopy, IArrow } from './Icons.jsx';

const NAV = [
  { to: '/feed', label: 'Feed', icon: IFeed, match: (p) => p === '/feed' },
  { to: '/launch', label: 'Launch', icon: IBolt, match: (p) => p === '/launch' },
  { to: '/explore', label: 'Explore', icon: ICompass, match: (p) => p === '/explore' || p.startsWith('/t/') },
  { to: '/mine', label: 'My Coins', short: 'Mine', icon: ICoins, match: (p) => p === '/mine' },
];
const LEARN = [{ to: '/how', label: 'Docs', short: 'Docs', icon: IDoc, match: (p) => p === '/how' || p === '/docs' }];

const handleUrl = (platform, h) => (platform === 'tiktok' ? `https://www.tiktok.com/@${String(h).replace(/^@/, '')}` : `https://x.com/${String(h).replace(/^@/, '')}`);

function AdsPill() {
  const cfg = useConfig();
  if (!cfg.token?.mint) return null;
  return (
    <button type="button" className="ads-pill" onClick={() => copy(cfg.token.mint, '$ADS address copied')} title="Copy the $ADS address">
      <b>${cfg.token.symbol || 'ADS'}</b><span className="mono">{short(cfg.token.mint, 4)}</span><ICopy size={13} />
    </button>
  );
}
export { AdsPill };

export function Shell({ path, children }) {
  const cfg = useConfig();
  const navLink = (n) => {
    const Icon = n.icon;
    return <Link key={n.to} href={n.to} className={`side-link ${n.match(path) ? 'on' : ''}`}><Icon size={18} /><span>{n.label}</span></Link>;
  };
  return (
    <div className="app">
      <div className={`announce ${cfg.ended ? 'ended' : ''}`}>
        {cfg.ended ? <span><b>Pumpfun Ads has ended.</b> Launching is closed. Coin pages stay up to view.</span> : <>
        <span className="pulse" />
        <span>Every coin is paired with <b>$ADS</b>. 20% of creator fees burn it, 80% become ads for the coin.</span>
        <Link href="/how" className="announce-link">How it works <IArrow size={12} /></Link>
        </>}
      </div>
      <aside className="side">
        <Brand />
        <nav className="side-nav">{NAV.map(navLink)}</nav>
        <div className="side-label">Learn</div>
        <nav className="side-nav">{LEARN.map(navLink)}</nav>
        <div className="side-foot">
          <AdsPill />
          <div className="side-socials">
            {cfg.socials?.x && <a href={handleUrl('x', cfg.socials.x)} target="_blank" rel="noreferrer"><IX size={14} />PumpfunAds</a>}
            {cfg.socials?.tiktok && <a href={handleUrl('tiktok', cfg.socials.tiktok)} target="_blank" rel="noreferrer"><ITikTok size={14} />PumpfunAds</a>}
            <a href="https://github.com/pumpfunads/PumpfunAds" target="_blank" rel="noreferrer"><IGithub size={14} />PumpfunAds</a>
          </div>
          <div className="side-note"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></div>
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <span className="top-brand"><Brand /></span>
          <div className="top-right">
            {path !== '/launch' && <Link href="/launch" className="btn primary glow">Launch</Link>}
            <WalletButton />
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
      <nav className="tabbar">
        {[...NAV, ...LEARN].map((n) => {
          const Icon = n.icon;
          return <Link key={n.to} href={n.to} className={n.match(path) ? 'on' : ''}><Icon size={20} /><span>{n.short || n.label}</span></Link>;
        })}
      </nav>
    </div>
  );
}
