import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll, useConfig } from '../lib/data.js';
import { Link } from '../lib/router.js';
import { amount, money, usd } from '../lib/format.js';
import { STEPS, VIDEO_EVERY_USD } from '../lib/ladder.js';
import { TokenIcon, WalletButton } from '../components/ui.jsx';
import { AdsPill } from '../components/Shell.jsx';
import { IArrow, ICheck, IFlame, IShield, IEye, IList, IGauge, IPlay, IX, ITikTok, IGithub, IMenu, IClose, IFilm, IImage, IGlobe } from '../components/Icons.jsx';

/*
 * The landing page (higgspad.com's structure, our look). Full width with its own top nav: the app pages keep the sidebar.
 * The showcase media is REAL Ads output: one run of the pipeline for a test coin ("a frog who only trades at 3am",
 * 10 Oct 2026), stored in web/public/showcase. It is labelled as an example wherever it appears.
 */
const SHOW = {
  video: '/showcase/frog-video.mp4',
  poster: '/showcase/frog-video.jpg',
  memes: [1, 2, 3, 4].map((i) => `/showcase/frog-meme-${i}.jpg`),
  pitch: 'A frog who only trades at 3am',
  name: 'Trading Frog',
  symbol: 'FROG',
};

const NAV = [['/feed', 'Feed'], ['/explore', 'Explore'], ['/launch', 'Launch'], ['/how', 'Docs']];

function TopNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="lnav">
      <Link href="/" className="lnav-brand" aria-label="Pumpfun Ads home"><img src="/mark.png?v=5" alt="Pumpfun Ads" width="44" height="44" /></Link>
      <nav className="lnav-links">
        {NAV.map(([to, label]) => <Link key={to} href={to}>{label}{to === '/launch' && <span className="new">new</span>}</Link>)}
      </nav>
      <div className="lnav-right">
        <a className="icon-btn lnav-x" href="https://x.com/pumpfunads" target="_blank" rel="noreferrer" aria-label="Pumpfun Ads on X"><IX size={14} /></a>
        <span className="lnav-wallet"><WalletButton /></span>
        <Link href="/launch" className="btn primary glow">Launch</Link>
        <button type="button" className="icon-btn lnav-menu" aria-label={open ? 'Close menu' : 'Menu'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? <IClose /> : <IMenu />}</button>
      </div>
      {open && (
        <nav className="lnav-drop" onClick={() => setOpen(false)}>
          {NAV.map(([to, label]) => <Link key={to} href={to}>{label}</Link>)}
          <Link href="/mine">My coins</Link>
          <div className="lnav-drop-wallet" onClick={(e) => e.stopPropagation()}><WalletButton big /></div>
        </nav>
      )}
    </header>
  );
}

/** A muted, looping clip that only plays while on screen (a phone on a landing page should not decode five videos). */
function Clip({ src, poster, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !('IntersectionObserver' in window)) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); }, { threshold: 0.25 });
    io.observe(v);
    return () => { io.disconnect(); };
  }, []);
  return <video ref={ref} className={className} src={src} poster={poster} muted loop playsInline preload="metadata" aria-label="Example video made by Pumpfun Ads" />;
}

function Hero() {
  return (
    <section className="lhero">
      <div className="lhero-glow" aria-hidden="true" />
      <div className="lhero-copy">
        <h1 className="lhero-title"><span className="accent">Pumpfun</span> <span>Ads</span></h1>
        <p className="lhero-lede">Launch a token and we become your marketing team.</p>
        <div className="row wrap" style={{ gap: 10 }}>
          <Link href="/launch" className="btn primary lg glow">Launch</Link>
          <Link href="/how" className="btn lg">How it works <IArrow /></Link>
        </div>
        <div style={{ marginTop: 18 }}><AdsPill /></div>
      </div>
      <div className="lhero-visual" aria-label="An example of what Pumpfun Ads makes">
        <div className="phone"><Clip src={SHOW.video} poster={SHOW.poster} /><span className="phone-tag">Example</span></div>
        <div className="float f1"><span className="chk"><ICheck size={12} /></span><div><b>Launch card</b><span>at launch</span></div></div>
        <div className="float f2"><span className="chk"><ICheck size={12} /></span><div><b>Content pack</b><span>at {money(STEPS.find((s) => s.key === 'meme_pack').atUsd)} in fees</span></div></div>
        <div className="float f3"><span className="chk live"><IPlay size={10} /></span><div><b>New video</b><span>every ${VIDEO_EVERY_USD} in fees</span></div></div>
      </div>
    </section>
  );
}

function Action() {
  return (
    <section className="lsec" id="action">
      <div className="lsec-head centered">
        <h2 className="lbig">See it in action</h2>
        <p>Real content made from a single line: <span className="quote">“{SHOW.pitch}.”</span></p>
      </div>
      <div className="action">
        <div className="action-video"><Clip src={SHOW.video} poster={SHOW.poster} /><span className="media-tag">10 s video</span></div>
        <div className="action-memes">
          {SHOW.memes.map((m, i) => <img key={m} src={m} alt={`Example meme ${i + 1}`} width="640" height="640" />)}
          <span className="media-tag">Content pack</span>
        </div>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="lsec">
      <div className="lsec-head centered"><h2 className="lbig">Three steps.</h2></div>
      <div className="steps">
        <article className="step">
          <div className="step-ui">
            <div className="mini">
              <div className="mini-label">Describe your coin in a sentence</div>
              <div className="mini-input">{SHOW.pitch}<span className="caret" /></div>
              <div className="mini-chips"><span className="on">Meme</span><span className="on">Lo-fi</span><span>Anime</span><span>Retro</span></div>
            </div>
          </div>
          <div className="step-body"><span className="step-n">01</span><h3>Describe it</h3><p>Write as much detail as you want, pick the style and where you want it posted: X, TikTok, or both.</p></div>
        </article>
        <article className="step">
          <div className="step-ui">
            <div className="mini dark">
              <div className="mini-label">Name</div>
              <div className="mini-input">{SHOW.name}</div>
              <div className="mini-label">Ticker</div>
              <div className="mini-input mono">${SHOW.symbol}</div>
              <div className="mini-token"><img src={SHOW.memes[0]} alt="" /><div><b>{SHOW.name}</b><span>${SHOW.symbol} · its address ends in "ads"</span></div></div>
            </div>
          </div>
          <div className="step-body"><span className="step-n">02</span><h3>Name it</h3><p>A name, a ticker and a logo. Upload one, or have one made from your description.</p></div>
        </article>
        <article className="step">
          <div className="step-ui">
            <div className="mini-launch">
              <span className="btn primary lg glow" aria-hidden="true">Launch</span>
              <ul>
                <li><ICheck size={13} />${SHOW.symbol} is live on Pumpfun</li>
                <li><ICheck size={13} />20% of fees burn $ADS</li>
                <li><ICheck size={13} />80% becomes its ads</li>
              </ul>
            </div>
          </div>
          <div className="step-body"><span className="step-n">03</span><h3>Launch it</h3><p>One transaction, signed in your wallet. Your dev buy stays yours. From there, we handle the marketing.</p></div>
        </article>
      </div>
    </section>
  );
}

const PLAN_ART = {
  launch_card: { icon: IImage, media: SHOW.memes[3] },
  meme_pack: { icon: IImage, media: SHOW.memes[1] },
  video: { icon: IFilm, video: true },
  trailer: { icon: IFilm },
  site: { icon: IGlobe },
};
function Plan() {
  return (
    <section className="lsec">
      <div className="lsec-head centered">
        <h2 className="lbig">The marketing plan</h2>
        <p>Content unlocks as your coin earns fees. Everything is reviewed and approved before it goes out.</p>
      </div>
      <div className="plan" role="list">
        {STEPS.map((s) => {
          const art = PLAN_ART[s.key] || {};
          const Icon = art.icon || IImage;
          return (
            <article className="plan-card" role="listitem" key={s.key}>
              <div className="plan-art">
                {art.video ? <Clip src={SHOW.video} poster={SHOW.poster} /> : art.media ? <img src={art.media} alt="" /> : <div className="plan-glyph"><Icon size={40} /></div>}
                <span className="plan-when">{s.onGraduation ? 'at bonding' : s.atUsd === 0 ? 'at launch' : s.key === 'video' ? `every ${money(VIDEO_EVERY_USD)}` : `at ${money(s.atUsd)}`}</span>
              </div>
              <div className="plan-body"><h3>{s.label}</h3>{s.detail && <p>{s.detail}</p>}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Live() {
  const [d] = usePoll(() => api.coins({ sort: 'top', limit: 24 }), 60_000);
  const coins = d?.coins || [];
  if (!coins.length) return null;
  const moving = coins.length >= 8; // a short list sits still, centred; a long one scrolls (doubled for a seamless loop)
  const row = moving ? [...coins, ...coins] : coins;
  return (
    <section className="lsec">
      <div className="live-count"><span className="dot" />{coins.length} {coins.length === 1 ? 'coin' : 'coins'} getting ads now</div>
      <div className={`marquee ${moving ? '' : 'still'}`}><div className="marquee-track">
        {row.map((c, i) => <Link key={`${c.mint}${i}`} href={`/t/${c.mint}`} className="tick" aria-hidden={i >= coins.length} tabIndex={i >= coins.length ? -1 : undefined}><TokenIcon src={c.image} label={c.symbol} size={26} /><b>${c.symbol}</b>{c.marketCapUsd != null && <span>{usd(c.marketCapUsd)}</span>}</Link>)}
      </div></div>
    </section>
  );
}

function Burn() {
  const [s] = usePoll(() => api.stats(), 60_000);
  const cells = [
    { k: 'burn', icon: IFlame, label: '$ADS burned', v: s ? amount(s.burnedAds) : '–' },
    { k: 'fees', label: 'Fees earned', v: s ? money(s.feesUsd) : '–' },
    { k: 'coins', label: 'Coins live', v: s ? s.coins.toLocaleString('en-US') : '–' },
    { k: 'videos', label: 'Videos made', v: s ? s.videos.toLocaleString('en-US') : '–' },
  ];
  return (
    <section className="lsec">
      <div className="lsec-head centered">
        <h2 className="lbig">Every fee burns $ADS</h2>
      </div>
      {/* Before the first coin the counters would all read zero: show the split itself instead. */}
      {s && s.coins > 0
        ? <div className="burn">{cells.map(({ k, icon: Icon, label, v }) => <div className="card burn-cell" key={k}><span className="burn-label">{Icon && <Icon size={14} />}{label}</span><b>{v}</b></div>)}</div>
        : <div className="burn-split"><div className="card"><span className="burn-label"><IFlame size={14} />Burns $ADS, for good</span><b>20%</b></div><div className="card ads"><span className="burn-label">Becomes the coin's ads</span><b>80%</b></div></div>}
    </section>
  );
}

const SAFE = [
  { icon: IGauge, title: 'Bounded spending', body: 'Daily caps per coin and across all coins. A coin only spends what its own fees brought in.' },
  { icon: IShield, title: 'Content check', body: 'Every caption and image is checked before it is made and before it is posted.' },
  { icon: IEye, title: 'Human review', body: 'Nothing goes out unseen. Everything is reviewed and approved before it is posted.' },
  { icon: IList, title: 'Spend log', body: 'Every dollar is tracked on your coin’s page, from fees earned to content created and money spent.' },
];
function Safety() {
  return (
    <section className="lsec">
      <div className="lsec-head centered">
        <h2 className="lbig">Fees pay for the ads.</h2>
        <p>Your coin is paired with $ADS. 20% of creator fees burn it, 80% pay for your ads.</p>
      </div>
      <div className="safe">{SAFE.map(({ icon: Icon, title, body }) => <div className="card safe-card" key={title}><span className="prop-ico"><Icon size={20} /></span><h3>{title}</h3><p>{body}</p></div>)}</div>
    </section>
  );
}

function Final() {
  return (
    <section className="lsec">
      <div className="final">
        <img className="final-a" src={SHOW.memes[0]} alt="" aria-hidden="true" />
        <img className="final-b" src={SHOW.memes[3]} alt="" aria-hidden="true" />
        <div className="final-copy">
          <h2 className="lbig">What will you launch?</h2>
          <Link href="/launch" className="btn primary lg glow">Launch</Link>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="lfoot">
      <div className="lfoot-top">
        <div className="lfoot-brand">
          <Link href="/" className="lnav-brand"><img src="/mark.png?v=5" alt="" width="34" height="34" /><span>Pumpfun Ads</span></Link>
          <p>A Pumpfun launchpad where every coin's creator fees pay for its marketing.</p>
        </div>
        <div className="lfoot-col"><h4>Product</h4><Link href="/feed">Feed</Link><Link href="/explore">Explore</Link><Link href="/launch">Launch</Link><Link href="/mine">My coins</Link></div>
        <div className="lfoot-col"><h4>Learn</h4><Link href="/how">Docs</Link><a href="https://github.com/pumpfunads/PumpfunAds" target="_blank" rel="noreferrer">GitHub</a></div>
        <div className="lfoot-col"><h4>Social</h4><a className="lfoot-social" href="https://x.com/pumpfunads" target="_blank" rel="noreferrer"><IX size={14} />PumpfunAds</a><a className="lfoot-social" href="https://www.tiktok.com/@pumpfunad" target="_blank" rel="noreferrer"><ITikTok size={14} />PumpfunAds</a></div>
        <div className="lfoot-col"><h4>Legal</h4><a href="/terms">Terms</a><a href="/privacy">Privacy</a></div>
      </div>
      <div className="lfoot-bottom">
        <span>© 2026 Pumpfun Ads · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></span>
        <span className="lfoot-icons"><a href="https://x.com/pumpfunads" target="_blank" rel="noreferrer" aria-label="X"><IX size={14} /></a><a href="https://www.tiktok.com/@pumpfunad" target="_blank" rel="noreferrer" aria-label="TikTok"><ITikTok size={14} /></a><a href="https://github.com/pumpfunads/PumpfunAds" target="_blank" rel="noreferrer" aria-label="GitHub"><IGithub size={14} /></a></span>
        <span>Solana · mainnet</span>
      </div>
    </footer>
  );
}

export default function Home() {
  const cfg = useConfig();
  return (
    <div className="landing">
      <div className={`announce ${cfg.ended ? 'ended' : ''}`}>
        {cfg.ended ? <span><b>Pumpfun Ads has ended.</b> Launching is closed. Coin pages stay up to view.</span> : <>
        <span className="pulse" />
        <span>Every coin is paired with <b>$ADS</b>. 20% of creator fees burn it, 80% become ads for the coin.</span>
        <Link href="/how" className="announce-link">How it works <IArrow size={12} /></Link>
        </>}
      </div>
      <TopNav />
      <main className="lmain">
        <Hero />
        <Action />
        <Steps />
        <Plan />
        <Live />
        <Burn />
        <Safety />
        <Final />
      </main>
      <Footer />
    </div>
  );
}
