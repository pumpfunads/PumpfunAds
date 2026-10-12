import { useRef, useState } from 'react';
import { api, isMock } from '../lib/api.js';
import { useConfig, feeLabel, pumpUrl, PLATFORM } from '../lib/data.js';
import { Link } from '../lib/router.js';
import { useWallet } from '../lib/wallet.jsx';
import { money } from '../lib/format.js';
import { volumeFor, STEPS } from '../lib/ladder.js';
import { TokenIcon, LadderList, CopyCA, PlatformIcon } from '../components/ui.jsx';
import { ICheck, IClose, IUpload, IImage, IArrow, IChevron, IExternal } from '../components/Icons.jsx';

const VIBES = ['Meme', 'Cinematic', 'Anime', 'Mascot', 'Cartoon', 'Realistic', 'Tech', 'Viral', 'Retro', 'Lo-fi', 'Chaotic'];
const STEP_NAMES = ['Describe', 'Name', 'Launch'];
const STAGES = [['prepare', 'Building the launch'], ['sign', 'Approve in your wallet'], ['send', 'Launching on Pumpfun'], ['done', 'Live']];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const step = (k) => STEPS.find((s) => s.key === k);

/** The plan the preview card shows, and the volume each step needs at the chosen fee. */
const PLAN = [
  { key: 'launch_card', label: 'Launch card', feesUsd: 0 },
  { key: 'meme_pack', label: 'Content pack', feesUsd: step('meme_pack').atUsd },
  { key: 'video', label: 'Video content', feesUsd: step('video').atUsd },
  { key: 'grad', label: 'Bonding campaigns', feesUsd: null },
];

function Field({ label, hint, count, children }) {
  return (
    <label className="field">
      <span className="field-head"><span className="label">{label}</span>{hint && <span className="muted small">{hint}</span>}{count && <span className="count">{count}</span>}</span>
      {children}
    </label>
  );
}

export default function Launch() {
  const cfg = useConfig();
  const w = useWallet();
  const fileRef = useRef(null);
  const [at, setAt] = useState(0);
  const [f, setF] = useState({ pitch: '', audience: '', mascot: '', name: '', symbol: '', website: '', twitter: '', telegram: '' });
  const [vibe, setVibe] = useState([]);
  const [platforms, setPlatforms] = useState({ x: true, tiktok: true });
  const [image, setImage] = useState(null);
  const [ref, setRef] = useState(null); // optional reference image for the look (Details)
  const [refNote, setRefNote] = useState(null);
  const [imageNote, setImageNote] = useState(null);
  const [gen, setGen] = useState({ busy: false, remaining: null });
  const [dragging, setDragging] = useState(false);
  const [fee, setFee] = useState(100);
  const [buy, setBuy] = useState('');
  const [stage, setStage] = useState(null);
  const [error, setError] = useState(null);
  const [pendingMint, setPendingMint] = useState(null);
  const [done, setDone] = useState(null);
  const [gate, setGate] = useState(false);

  const set = (k) => (e) => {
    let v = e.target.value;
    if (k === 'symbol') v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    setF((x) => ({ ...x, [k]: v }));
  };
  const toggleVibe = (v) => setVibe((x) => (x.includes(v) ? x.filter((y) => y !== v) : [...x, v]));
  const plats = Object.keys(platforms).filter((k) => platforms[k]);
  const buyNum = Number(buy || 0);
  const maxBuy = cfg.maxDevBuySol ?? 10;
  const closed = cfg.launchOpen === false;

  const okDescribe = f.pitch.trim().length >= 3 && plats.length > 0;
  const okName = f.name.trim().length > 0 && f.symbol.length > 0 && Boolean(image);
  const okLaunch = Number.isFinite(buyNum) && buyNum >= 0 && buyNum <= maxBuy;
  const ok = [okDescribe, okName, okLaunch];
  const why = !okDescribe ? (plats.length ? 'Describe your coin first' : 'Pick X, TikTok or both') : !okName ? (!f.name.trim() ? 'Give it a name' : !f.symbol ? 'Give it a ticker' : 'Add a logo') : !okLaunch ? `Dev buy is 0 to ${maxBuy} SOL` : null;

  const pickImage = (file) => {
    setImageNote(null);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { setImageNote('Use a PNG, JPG, WebP or GIF.'); return; }
    if (file.size > 4 * 1024 * 1024) { setImageNote('That image is over 4 MB.'); return; }
    const r = new FileReader();
    r.onload = () => setImage(r.result);
    r.readAsDataURL(file);
  };
  const pickRef = (file) => {
    setRefNote(null);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { setRefNote('Use a PNG, JPG, WebP or GIF.'); return; }
    if (file.size > 4 * 1024 * 1024) { setRefNote('That image is over 4 MB.'); return; }
    // Shrunk in the browser to at most 1024 px (JPEG): a style reference needs no more, and the launch request stays
    // well under the server's body limit next to the logo.
    createImageBitmap(file).then((bmp) => {
      const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      setRef(c.toDataURL('image/jpeg', 0.85));
    }).catch(() => setRefNote('That image could not be read. Try another one.'));
  };
  const generate = async () => {
    setImageNote(null);
    setGen((g) => ({ ...g, busy: true }));
    try {
      if (!w.signedIn) await w.signIn();
      const r = await api.logo({ description: [f.pitch, f.mascot].filter(Boolean).join('. '), name: f.name, symbol: f.symbol, style: vibe.join(', ') });
      setImage(r.imageData);
      setGen({ busy: false, remaining: r.remaining ?? null });
    } catch (e) {
      setGen((g) => ({ ...g, busy: false }));
      setImageNote(e.status === 429 ? 'You have used your 3 free logos today. Upload one instead.' : /reject|cancel|closed/i.test(e.message) ? 'Sign in to generate a logo.' : e.message);
    }
  };

  const go = async () => {
    if (closed) { setGate(true); return; }
    if (!ok.every(Boolean)) return;
    setError(null);
    let mint = null;
    let sent = false;
    try {
      if (!w.signedIn) await w.signIn();
      setStage('prepare');
      const p = await api.prepare({
        name: f.name.trim(), symbol: f.symbol, description: f.pitch.trim(), imageData: image,
        brief: { pitch: f.pitch.trim(), vibe, audience: f.audience.trim(), mascot: f.mascot.trim(), platforms: plats },
        refImageData: ref || undefined,
        creatorFeeBps: fee, devBuy: buyNum > 0 ? { amount: buy } : null,
        website: f.website.trim() || undefined, twitter: f.twitter.trim() || undefined, telegram: f.telegram.trim() || undefined,
      });
      mint = p.mint;
      setStage('sign');
      const signed = isMock ? p.transactions : await w.signTransactions(p.transactions);
      sent = true;
      setStage('send');
      setPendingMint(mint);
      await api.submit(p.mint, signed);
      setStage('done');
      setDone({ mint: p.mint });
      setPendingMint(null);
    } catch (err) {
      setStage(null);
      const cancelled = err.code === 4001 || /reject|cancel|closed/i.test(err.message);
      setError(cancelled ? 'Cancelled in the wallet. Nothing was sent.' : err.message);
      // Once a signed launch left this page, only a definite refusal ('launch') means it did not land. Anything else
      // (lock, unknown, a dropped connection, a 502 from the proxy) keeps Finish launch on screen.
      if (!(mint && sent && err.stage !== 'launch')) setPendingMint(null);
    }
  };
  const finish = async () => {
    setError(null);
    setStage('send');
    try {
      await api.relock(pendingMint);
      setStage('done');
      setDone({ mint: pendingMint });
      setPendingMint(null);
    } catch (e) {
      setStage(null);
      setError(e.message);
      if (e.stage === 'launch') setPendingMint(null);
    }
  };

  if (done) return <Success mint={done.mint} name={f.name} symbol={f.symbol} image={image} plats={plats} />;

  const volNote = (feesUsd) => {
    if (feesUsd == null) return 'at bonding';
    if (feesUsd === 0) return 'at launch';
    const v = volumeFor(feesUsd, fee);
    return v == null ? `at ${money(feesUsd)} in fees` : `~${money(v)} volume`;
  };
  const filled = [Boolean(f.name && f.symbol), f.pitch.trim().length >= 3, vibe.length > 0, Boolean(image)];
  const planRows = PLAN.map((r, i) => ({ key: r.key, label: r.label, state: filled[i] ? 'done' : i === filled.indexOf(false) ? 'next' : 'locked', feesUsd: r.feesUsd }));

  return (
    <div className="page launch">
      <div className="launch-grid">
        <div className="launch-form">
          <div className="stepper">
            <div className="stepper-bar"><i style={{ width: `${((at + 1) / 3) * 100}%` }} /></div>
            <div className="stepper-labels">
              {STEP_NAMES.map((n, i) => (
                <button type="button" key={n} className={i === at ? 'on' : i < at ? 'past' : ''} disabled={i > at && !ok.slice(0, i).every(Boolean)} onClick={() => setAt(i)}>
                  <span className="num">{i < at ? <ICheck size={12} /> : i + 1}</span>{n}
                </button>
              ))}
            </div>
          </div>

          {at === 0 && (
            <section className="stack-lg">
              <div className="step-head">
                <div className="eyebrow">Step 1 of 3</div>
                <h1 className="display">What are you launching?</h1>
                <p className="lede">Write as much detail as you want, pick the style and where you want it posted.</p>
              </div>
              <Field label="Describe your coin" count={`${f.pitch.length}/500`}>
                <textarea className="textarea big" maxLength={500} rows={4} value={f.pitch} onChange={set('pitch')} placeholder="A frog who only trades at 3am" autoFocus />
              </Field>
              <div className="field">
                <span className="field-head"><span className="label">Style</span><span className="muted small">pick any</span></span>
                <div className="chips">{VIBES.map((v) => <button type="button" key={v} aria-pressed={vibe.includes(v)} className={`chip ${vibe.includes(v) ? 'on' : ''}`} onClick={() => toggleVibe(v)}>{vibe.includes(v) && <ICheck size={13} />}{v}</button>)}</div>
              </div>
              <Field label="Who is it for" hint="optional">
                <input className="input" maxLength={120} value={f.audience} onChange={set('audience')} placeholder="Night owls, chart watchers, frog people" />
              </Field>
              <Field label="Details" hint="optional" count={`${f.mascot.length}/500`}>
                <div className="details-box">
                  <textarea className="textarea" maxLength={500} rows={3} value={f.mascot} onChange={set('mascot')} placeholder="A small green frog in a hoodie, lit by a glowing monitor" />
                  <div className="details-ref">
                    {ref ? (
                      <span className="ref-thumb"><img src={ref} alt="Your reference image" /><button type="button" className="icon-btn" aria-label="Remove the image" onClick={() => setRef(null)}><IClose size={14} /></button></span>
                    ) : (
                      <label className="btn sm"><IUpload size={14} />Add an image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { pickRef(e.target.files?.[0]); e.target.value = ''; }} /></label>
                    )}
                    <span className="small muted">{refNote || 'Optional: Upload a reference image for the style you want. Describe what you want us to take from it above.'}</span>
                  </div>
                </div>
              </Field>
              <div className="field">
                <span className="field-head"><span className="label">Social media</span><span className="muted small">at least one</span></span>
                <div className="toggles">
                  {['x', 'tiktok'].map((p) => (
                    <button type="button" key={p} role="switch" aria-checked={platforms[p]} className={`toggle ${platforms[p] ? 'on' : ''}`} onClick={() => setPlatforms((x) => ({ ...x, [p]: !x[p] }))}>
                      <PlatformIcon p={p} size={16} /><span>{PLATFORM[p]}</span><span className="switch"><i /></span>
                    </button>
                  ))}
                </div>
                {!plats.length && <span className="small bad-text">Pick X, TikTok or both.</span>}
              </div>
            </section>
          )}

          {at === 1 && (
            <section className="stack-lg">
              <div className="step-head">
                <div className="eyebrow">Step 2 of 3</div>
                <h1 className="display">Name it</h1>
                <p className="lede">The name, ticker and logo seen on Pumpfun.</p>
              </div>
              <div className="two">
                <Field label="Name" count={`${f.name.length}/32`}><input className="input" maxLength={32} value={f.name} onChange={set('name')} placeholder="Trading Frog" autoFocus /></Field>
                <Field label="Ticker" count={`${f.symbol.length}/10`}><div className="ticker-input"><span>$</span><input className="input mono" value={f.symbol} onChange={set('symbol')} placeholder="FROG" /></div></Field>
              </div>
              <div className="field">
                <span className="field-head"><span className="label">Logo</span><span className="muted small">PNG, JPG, WebP or GIF, up to 4 MB</span></span>
                <div className="logo-row">
                  <div className="logo-preview">{image ? <img src={image} alt="Your logo" /> : <span className="muted">{f.symbol ? f.symbol.slice(0, 3) : 'Logo'}</span>}</div>
                  <div className="logo-actions">
                    <button type="button" className={`dropzone ${dragging ? 'over' : ''}`} onClick={() => fileRef.current?.click()}
                      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                      onDrop={(e) => { e.preventDefault(); setDragging(false); pickImage(e.dataTransfer.files?.[0]); }}>
                      <IUpload size={18} /><b>{image ? 'Upload another' : 'Upload a logo'}</b><span>or drop it here</span>
                    </button>
                    <button type="button" className="btn gen" onClick={generate} disabled={gen.busy || !f.pitch.trim()}>
                      {gen.busy ? <span className="spinner" /> : <IImage size={16} />}<span>{gen.busy ? 'Drawing your logo' : 'Generate a logo'}</span>
                      <span className="free">{gen.remaining != null ? `${gen.remaining} left today` : '3 free per day'}</span>
                    </button>
                  </div>
                </div>
                <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
                {imageNote && <div className="notice bad small">{imageNote}</div>}
              </div>
              <div className="two">
                <Field label="Website" hint="optional"><input className="input" value={f.website} onChange={set('website')} placeholder="https://" /></Field>
                <Field label="X" hint="optional"><input className="input" value={f.twitter} onChange={set('twitter')} placeholder="https://x.com/…" /></Field>
              </div>
            </section>
          )}

          {at === 2 && (
            <section className="stack-lg">
              <div className="step-head">
                <div className="eyebrow">Step 3 of 3</div>
                <h1 className="display">Launch it</h1>
                <p className="lede">Every token is paired with $ADS.</p>
              </div>
              <div className="field">
                <span className="field-head centered"><span className="label">Creator fee</span></span>
                <div className="fee-grid">
                  {cfg.feeRates.map((b) => (
                    <button type="button" key={b} className={`fee-opt ${fee === b ? 'on' : ''}`} onClick={() => setFee(b)} aria-pressed={fee === b}>
                      <b>{feeLabel(b)}</b>
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-head centered"><span className="label">Dev buy</span><span className="muted small">optional</span></span>
                <div className="sol-field buy">
                  <input inputMode="decimal" aria-label="Dev buy in SOL" value={buy} onChange={(e) => setBuy(e.target.value.replace(',', '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} placeholder="0.0" />
                  <span className="sol-tag">SOL</span>
                </div>
                <div className="buy-chips">{['0.1', '0.5', '1', '2'].map((v) => <button type="button" key={v} className={`chip ${buy === v ? 'on' : ''}`} onClick={() => setBuy(buy === v ? '' : v)}>{v} SOL</button>)}</div>
                {!okLaunch && <span className="small bad-text">Up to {maxBuy} SOL.</span>}
              </div>
              <div className="card summary">
                <div className="label" style={{ textAlign: 'center' }}>Summary</div>
                <dl>
                  <div><dt>Coin</dt><dd>{f.name || '–'} <span className="green">${f.symbol || '–'}</span></dd></div>
                  <div><dt>Address ends in</dt><dd className="mono">…{cfg.vanity?.suffix || 'ads'}</dd></div>
                  <div><dt>Paired with</dt><dd>$ADS</dd></div>
                  <div><dt>Creator fee</dt><dd>{feeLabel(fee)}</dd></div>
                  <div><dt>Fees</dt><dd>20% burn $ADS · 80% your ads</dd></div>
                  <div><dt>Dev buy</dt><dd>{buyNum > 0 ? `${buy} SOL to your wallet` : 'none'}</dd></div>
                  <div><dt>Social media</dt><dd>{plats.map((p) => PLATFORM[p]).join(' and ') || '–'}</dd></div>
                </dl>
              </div>
              {stage && (
                <div className="stages">
                  {STAGES.map(([k, l], i) => {
                    const cur = STAGES.findIndex(([x]) => x === stage);
                    return <div key={k} className={i < cur ? 'done' : i === cur ? 'on' : ''}>{i < cur ? <ICheck size={14} /> : i === cur ? <span className="spinner" /> : <span className="dot" />}{l}</div>;
                  })}
                </div>
              )}
              {error && <div className="notice bad">{error}</div>}
              {pendingMint && !stage && (
                <div className="notice">
                  Your launch may have landed. Finish launch checks the chain and opens your coin.
                  <button type="button" className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={finish}>Finish launch</button>
                </div>
              )}
            </section>
          )}

          <div className="form-nav">
            {at > 0 ? <button type="button" className="btn" onClick={() => setAt(at - 1)} disabled={Boolean(stage)}><IChevron dir="left" />Back</button> : <span />}
            {at < 2 ? (
              <button type="button" className="btn primary lg" disabled={!ok[at]} onClick={() => setAt(at + 1)}>Continue<IArrow /></button>
            ) : (
              <button type="button" className="btn primary lg glow" disabled={!closed && (!ok.every(Boolean) || Boolean(stage))} onClick={go}>
                {cfg.ended ? 'Pumpfun Ads has ended' : closed ? 'Launching opens soon' : stage ? 'Launching' : w.signedIn ? 'Launch' : 'Sign in and launch'}
              </button>
            )}
          </div>
          {at === 2 && !closed && why && <p className="small muted right">{why}</p>}
        </div>

        <aside className="launch-side">
          <div className="card preview">
            <div className="preview-top">
              <div className="preview-logo">{image ? <img src={image} alt="" /> : <span>{f.symbol ? f.symbol.slice(0, 3) : '?'}</span>}</div>
              <div className="min0">
                <div className="preview-name">{f.name || 'Your coin'}</div>
                <div className="sym">${f.symbol || 'TICKER'}</div>
              </div>
              <span className="badge live">Preview</span>
            </div>
            <p className="preview-pitch">{f.pitch || 'Describe your coin and it shows up here.'}</p>
            {(vibe.length > 0 || plats.length > 0) && (
              <div className="chips sm preview-chips">
                {vibe.map((v) => <span key={v} className="chip static">{v}</span>)}
                {plats.map((p) => <span key={p} className="chip static"><PlatformIcon p={p} size={11} />{PLATFORM[p]}</span>)}
              </div>
            )}
            <hr className="sep" />
            <div className="row between"><span className="label">Your marketing plan</span><span className="small muted">{feeLabel(fee)} fee</span></div>
            <LadderList compact rows={planRows} note={(r) => volNote(PLAN.find((x) => x.key === r.key)?.feesUsd)} />
            <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>Every additional {money(step('video').repeatEveryUsd)} in fees unlocks another video.</p>
          </div>
        </aside>
      </div>

      {gate && (
        <div className="overlay" onClick={() => setGate(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Launching opens soon" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head"><h3>{cfg.ended ? 'Pumpfun Ads has ended' : 'Launching opens soon'}</h3><button className="icon-btn" aria-label="Close" onClick={() => setGate(false)}><IClose /></button></div>
            <p className="muted">{cfg.ended ? 'Launching is closed. Coin pages stay up to view.' : <>Your draft stays on this page. Follow {cfg.socials?.x || '@pumpfunads'} to hear the moment launching opens.</>}</p>
            <button className="btn primary block" onClick={() => setGate(false)}>Keep editing</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Success({ mint, name, symbol, image, plats }) {
  return (
    <div className="page narrow success">
      <div className="success-logo">{image ? <img src={image} alt="" /> : <TokenIcon label={symbol} size={96} />}</div>
      <div className="eyebrow">Live on Pumpfun</div>
      <h1 className="display">{name || 'Your coin'} is live</h1>
      <p className="lede">Your launch card is on its way to {plats.map((p) => PLATFORM[p]).join(' and ')}. Your content pack unlocks at ${step('meme_pack').atUsd} in fees and your first video at ${step('video').atUsd}. We take it from here.</p>
      <div className="row wrap center" style={{ gap: 10 }}>
        <Link href={`/t/${mint}`} className="btn primary lg glow">Open ${symbol}<IArrow /></Link>
        <a href={pumpUrl(mint)} target="_blank" rel="noreferrer" className="btn lg">Trade on Pumpfun <IExternal /></a>
      </div>
      <CopyCA mint={mint} />
    </div>
  );
}
