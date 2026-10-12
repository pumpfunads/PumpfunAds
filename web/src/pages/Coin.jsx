import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll, feeLabel, pumpUrl, useConfig, PLATFORM, toast, copy } from '../lib/data.js';
import { Link } from '../lib/router.js';
import { useWallet } from '../lib/wallet.jsx';
import { usd, money, ago, amount, short } from '../lib/format.js';
import { ladderFor, STEPS } from '../lib/ladder.js';
import { TokenIcon, Progress, phaseText, LadderList, CopyCA, Media, PostedTo, PlatformIcon, Loading, ErrorState, Empty } from '../components/ui.jsx';
import { IExternal, IDownload, IGraduate, ICopy, IX, ITikTok, IGlobe } from '../components/Icons.jsx';

const KIND = { credit: 'Fees in', spend: 'Spent', refund: 'Refund', platform: 'On us' };
const entryUsd = (e) => e.usd ?? (e.usdMicros != null ? e.usdMicros / 1e6 : e.usd_micros != null ? e.usd_micros / 1e6 : null);

function Socials({ c }) {
  const w = useWallet();
  const [busy, setBusy] = useState(null);
  const [gone, setGone] = useState({});
  const mine = w.signedIn && w.session === c.launcher;
  const [site, setSite] = useState(c.siteStatus || 'none');
  useEffect(() => { setSite(c.siteStatus || 'none'); }, [c.siteStatus]);
  if (!mine) return null;
  const claim = async () => {
    setBusy('site');
    try { const r = await api.claimSite(c.mint); setSite(r.status); toast('Your website is being made', 4000); } catch (e) { toast(e.message, 5000); } finally { setBusy(null); }
  };
  const unlink = async (p) => {
    setBusy(p);
    try { await api.unlinkSocial(c.mint, p); setGone((g) => ({ ...g, [p]: true })); toast(`${PLATFORM[p]} unlinked`); } catch (e) { toast(e.message); } finally { setBusy(null); }
  };
  return (
    <div className="card pad">
      <div className="label">Your coin</div>
      {!c.graduated ? (
        <p className="small muted" style={{ marginBottom: 0 }}>When ${c.symbol} bonds you can claim a free website and link your own X and TikTok. We post to your X, and TikTok drafts land in your inbox for you to publish.</p>
      ) : (
        <div className="stack" style={{ marginTop: 12 }}>
          {['x', 'tiktok'].map((p) => {
            const linked = !gone[p] && c.socials?.[p];
            return (
              <div className="social-row" key={p}>
                <PlatformIcon p={p} size={16} />
                <div className="min0" style={{ flex: 1 }}>
                  <b>{PLATFORM[p]}</b>
                  <div className="small muted">{linked ? `Linked as ${linked.handle}` : p === 'x' ? 'We post your ads to it' : 'Drafts go to your inbox'}</div>
                </div>
                {linked ? <button className="btn sm" disabled={busy === p} onClick={() => unlink(p)}>Unlink</button>
                  : <a className="btn sm primary" href={api.socialConnectUrl(c.mint, p)}>Link your {PLATFORM[p]}</a>}
              </div>
            );
          })}
          <div className="social-row">
            <IGlobe size={16} />
            <div className="min0" style={{ flex: 1 }}>
              <b>Your website</b>
              <div className="small muted">{site === 'ready' ? 'Live at the top of this page' : site === 'making' ? 'Being made. It appears here once approved.' : 'Free, built around your coin'}</div>
            </div>
            {site === 'none' && <button className="btn sm primary" disabled={busy === 'site'} onClick={claim}>{busy === 'site' ? 'Claiming' : 'Claim'}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The OAuth return: the API sends the launcher back to /t/<mint>?social=x&linked=1 (or &error=...). Read once, then drop. */
function readSocialReturn() {
  try {
    const q = new URLSearchParams(location.search);
    const p = q.get('social');
    if (!p) return null;
    const name = PLATFORM[p] || p;
    return q.get('linked') ? { ok: true, text: `Your ${name} is linked. We post there from now on.` } : { ok: false, text: `Linking your ${name} did not finish${q.get('error') ? `: ${q.get('error')}` : ''}. Try again.` };
  } catch {
    return null;
  }
}

const socialUrl = (p, h) => (p === 'tiktok' ? `https://www.tiktok.com/@${String(h).replace(/^@/, '')}` : `https://x.com/${String(h).replace(/^@/, '')}`);

/** The coin's own landing page, when Ads has made its site: hero, headline, tagline, the copy, buy + CA. */
function SiteHero({ c, site }) {
  const hero = site.hero;
  const linked = ['x', 'tiktok'].filter((p) => c.socials?.[p]?.handle);
  return (
    <section className="site">
      {hero && (hero.url || hero.thumb) && (
        <div className="site-hero">
          {String(hero.mime || '').startsWith('video/') || (!hero.mime && hero.kind === 'video')
            ? <video src={hero.url} poster={hero.thumb || undefined} autoPlay muted loop playsInline />
            : <img src={hero.url || hero.thumb} alt="" />}
        </div>
      )}
      <div className="site-body">
        <div className="row" style={{ gap: 12 }}>
          <TokenIcon src={c.image} label={c.symbol} size={48} />
          <span className="sym big">${c.symbol}</span>
        </div>
        <h1 className="site-headline">{site.headline || c.name}</h1>
        {site.tagline && <p className="site-tagline">{site.tagline}</p>}
        {(site.paragraphs || []).map((t, i) => <p key={i} className="site-p">{t}</p>)}
        <div className="row wrap" style={{ gap: 10, marginTop: 8 }}>
          <a className="btn primary lg glow" href={c.links?.pump || pumpUrl(c.mint)} target="_blank" rel="noreferrer">Buy on Pumpfun <IExternal /></a>
          <button type="button" className="btn lg" onClick={() => copy(c.mint, 'Address copied')}><ICopy size={15} />Copy CA</button>
          {linked.map((p) => <a key={p} className="btn lg" href={socialUrl(p, c.socials[p].handle)} target="_blank" rel="noreferrer">{p === 'x' ? <IX size={15} /> : <ITikTok size={15} />}{c.socials[p].handle}</a>)}
        </div>
      </div>
    </section>
  );
}

function FeesList({ fees }) {
  if (!fees?.length) return null;
  return (
    <div className="card pad">
      <div className="label">Fees collected</div>
      <div className="fees">
        {fees.map((f, i) => (
          <div className="fee-row" key={f.sig || i}>
            <div className="min0">
              <div className="small"><span className="green mono">{amount(Number(f.burned || 0))}</span> $ADS burned</div>
              <div className="small muted"><span className="mono">{amount(Number(f.toAds || 0))}</span> $ADS to the ad budget · {ago(f.at)}{f.status && f.status !== 'ok' ? ` · ${f.status}` : ''}</div>
            </div>
            {f.url && <a className="icon-btn" href={f.url} target="_blank" rel="noreferrer" title="View transaction" aria-label="View transaction"><IExternal /></a>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Coin({ mint }) {
  const cfg = useConfig();
  const [notice, setNotice] = useState(readSocialReturn);
  useEffect(() => {
    if (notice) history.replaceState(null, '', location.pathname);
  }, []);
  const [c, err, retry] = usePoll(() => api.coin(mint), 30_000, [mint], { reset: true });
  if (err && !c) {
    return err.status === 404
      ? <div className="page narrow"><h1 className="display sm">Not launched on Pumpfun Ads</h1><p className="muted">No coin at {short(mint, 6)} launched here.</p><Link href="/explore" className="btn">All coins</Link></div>
      : <div className="page"><ErrorState error={err} retry={retry} title="This coin did not load" /></div>;
  }
  if (!c) return <div className="page"><Loading /></div>;
  return <CoinView c={c} cfg={cfg} notice={notice} onDismiss={() => setNotice(null)} />;
}

export function CoinView({ c, cfg, notice, onDismiss }) {
  const graduated = c.graduated ?? c.phase === 'graduated';
  const ext = c.origin === 'external'; // $ADS itself: no plan, budget or creator fee of its own
  const w = useWallet();
  const mine = w.signedIn && w.session === c.launcher;
  const b = c.budget || {};
  const ladder = c.ladder?.length ? c.ladder : ladderFor({ lifetimeUsd: b.lifetimeUsd || 0, graduated }).steps;
  const next = b.nextStep;
  const gallery = c.gallery || [];
  const ledger = c.ledger || [];
  const brief = c.brief || {};

  const links = c.links || {};
  return (
    <div className="page">
      {notice && <div className={`notice ${notice.ok ? 'good' : 'bad'}`} style={{ marginBottom: 16 }}><span style={{ flex: 1 }}>{notice.text}</span>{onDismiss && <button className="btn sm" onClick={onDismiss}>Close</button>}</div>}
      {c.site && <><SiteHero c={c} site={c.site} /><div className="made-by"><span>Made by Pumpfun Ads</span></div></>}
      <div className="coin-head card">
        <TokenIcon src={c.image} label={c.symbol} size={88} />
        <div className="min0" style={{ flex: 1 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            {c.site ? <h2 className="display sm" style={{ margin: 0 }}>{c.name}</h2> : <h1 className="display sm" style={{ margin: 0 }}>{c.name}</h1>}
            {c.demo ? <span className="badge">Demo</span> : graduated && <span className="badge green"><IGraduate size={13} />Graduated</span>}
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            <span className="sym big">${c.symbol}</span>
            {ext ? <span className="badge green">The Pumpfun Ads token</span> : <>
              <span className="badge">paired with $ADS</span>
              <span className="badge">{feeLabel(c.creatorFeeBps)} creator fee</span>
            </>}
            <CopyCA mint={c.mint} />
          </div>
          {brief.pitch && <p className="muted" style={{ margin: '12px 0 0' }}>{brief.pitch}</p>}
          {ext && c.description && <p className="muted" style={{ margin: '12px 0 0' }}>{c.description}</p>}
        </div>
        <div className="coin-head-side">
          <div className="coin-cap"><span className="mono">{usd(c.marketCapUsd)}</span><small>market cap</small></div>
          <Progress value={c.progress} graduated={graduated} />
          <div className="small muted">{c.demo ? 'A demo coin: it exists only on this site' : graduated ? 'Graduated' : phaseText(c)}</div>
          {!c.demo && <div className="row wrap" style={{ gap: 8 }}>
            <a className="btn primary sm" href={links.pump || pumpUrl(c.mint)} target="_blank" rel="noreferrer">Trade on Pumpfun <IExternal /></a>
            {links.dex && <a className="btn sm" href={links.dex} target="_blank" rel="noreferrer">Chart <IExternal /></a>}
          </div>}
        </div>
      </div>

      {ext ? (
        <section className="card pad" style={{ marginTop: 16 }}>
          <h2 className="h3">Every coin on Pumpfun Ads is paired with ${c.symbol}</h2>
        </section>
      ) : <div className="coin-cols">
        <div className="stack-lg min0">
          <section className="card pad">
            <h2 className="h3" style={{ textAlign: 'center' }}>Marketing plan</h2>
            <LadderList rows={ladder} />
          </section>

          <section>
            <div className="section-head"><h2 className="h3">Gallery</h2><span className="small muted">{gallery.length} {gallery.length === 1 ? 'piece' : 'pieces'}</span></div>
            {gallery.length === 0 ? <Empty>Nothing made yet. The launch card is first, the content pack follows at {money(STEPS.find((s) => s.key === 'meme_pack').atUsd)} in fees.</Empty> : (
              <div className="gallery">
                {gallery.map((a) => (
                  <figure className="card gallery-item" key={a.id}>
                    <Media item={a} controls />
                    <figcaption>
                      {a.caption && <p>{a.caption}</p>}
                      <div className="row between small muted">
                        <span>{ago(a.createdAt)}</span>
                        <span className="row" style={{ gap: 10 }}>
                          <PostedTo list={a.postedTo} />
                          {mine && c.socials?.tiktok && a.kind === 'video' && !a.mock && <SendTikTok mint={c.mint} id={a.id} />}
                          {(a.url || a.thumb) && <a className="dl" href={a.url || a.thumb} download target="_blank" rel="noreferrer" title="Download" aria-label="Download"><IDownload size={16} /></a>}
                        </span>
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="section-head"><h2 className="h3">Spend log</h2><span className="small muted">Every dollar in and out of the ad budget</span></div>
            {ledger.length === 0 ? <Empty>No entries yet. Fees are sold for the budget once a day.</Empty> : (
              <div className="card ledger">
                {ledger.map((e, i) => {
                  const v = entryUsd(e);
                  const out = e.kind === 'spend';
                  return (
                    <div className="ledger-row" key={e.id ?? i}>
                      <span className={`badge ${e.kind === 'credit' || e.kind === 'refund' ? 'green' : ''}`}>{KIND[e.kind] || e.kind}</span>
                      <span className="min0 ledger-note">{e.kind === 'credit' ? '' : e.note || e.ref || ''}</span>
                      <span className={`mono ${out ? '' : 'green'}`}>{v == null ? '' : `${out ? '−' : e.kind === 'platform' ? '' : '+'}${money(v)}`}</span>
                      <span className="small muted ledger-when">{ago(e.createdAt || e.created_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside className="stack-lg">
          <div className="card pad budget">
            <div className="label">Ad budget</div>
            <div className="budget-big mono">{money(b.balanceUsd ?? 0)}</div>
            <dl>
              <div><dt>Lifetime fees</dt><dd className="mono">{money(c.feesUsd ?? b.lifetimeUsd ?? 0)}</dd></div>
              {next && <div><dt>Next unlock</dt><dd>{next.label} in {money(next.remainingUsd)}</dd></div>}
            </dl>
          </div>
          {(brief.vibe?.length > 0 || brief.platforms?.length > 0 || brief.audience || brief.mascot) && (
            <div className="card pad">
              <div className="label" style={{ textAlign: 'center' }}>Style</div>
              {brief.vibe?.length > 0 && <div className="chips sm" style={{ marginTop: 10, justifyContent: 'center' }}>{brief.vibe.map((v) => <span key={v} className="chip static">{v}</span>)}</div>}
              {brief.audience && <p className="small"><span className="muted">For </span>{brief.audience}</p>}
              {brief.mascot && <p className="small"><span className="muted">Look </span>{brief.mascot}</p>}
              {brief.platforms?.length > 0 && <div className="row small muted" style={{ gap: 8, justifyContent: 'center', marginTop: 12 }}>Posting on {brief.platforms.map((p) => <span key={p} className="row" style={{ gap: 4 }}><PlatformIcon p={p} size={12} />{PLATFORM[p]}</span>)}</div>}
            </div>
          )}
          <FeesList fees={c.fees} />
          <Socials c={{ ...c, graduated }} />
        </aside>
      </div>}
    </div>
  );
}

/** One video into the launcher's TikTok inbox as a draft: they finish and post it in TikTok. */
function SendTikTok({ mint, id }) {
  const [state, setState] = useState(null);
  const go = async () => {
    setState('busy');
    try {
      await api.sendTikTok(mint, id);
      setState('sent');
      toast('Sent. Open TikTok: the draft is in your inbox.', 5000);
    } catch (e) {
      setState(null);
      toast(e.message, 5000);
    }
  };
  return <button className="btn sm" disabled={state !== null} onClick={go}><ITikTok size={13} />{state === 'busy' ? 'Sending…' : state === 'sent' ? 'In your inbox' : 'Send to TikTok'}</button>;
}
