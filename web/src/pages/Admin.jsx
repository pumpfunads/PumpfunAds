import { useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll, toast } from '../lib/data.js';
import { Link } from '../lib/router.js';
import { ago, money } from '../lib/format.js';
import { Media, Loading, ErrorState, Empty } from '../components/ui.jsx';

/** Plain operator page. Signs in with the admin token (a cookie set by /api/admin/login/<token>). */
const TABS = [['overview', 'Overview'], ['review', 'Review queue'], ['campaigns', 'Ad campaigns'], ['tiktok', 'TikTok queue']];

const label = (k) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const show = (v) => (v == null ? '–' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : /^\d{4}-\d\d-\d\dT/.test(String(v)) ? ago(v) : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));

function Overview() {
  const [d, err, retry] = usePoll(() => api.admin.overview(), 30_000);
  if (err && !d) return <ErrorState error={err} retry={retry} />;
  if (!d) return <Loading />;
  const flat = Object.entries(d).filter(([, v]) => v == null || typeof v !== 'object');
  const groups = Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  return (
    <div className="stack">
      <div className="admin-stats">{flat.map(([k, v]) => <div className="card" key={k}><span className="small muted">{label(k)}</span><b className="mono">{show(v)}</b></div>)}</div>
      {groups.map(([g, o]) => (
        <div className="card pad" key={g}>
          <div className="label">{label(g)}</div>
          <dl className="kv">{Object.entries(o).map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd className="mono">{typeof v === 'object' && v ? JSON.stringify(v) : show(v)}</dd></div>)}</dl>
        </div>
      ))}
    </div>
  );
}

/** Each coin's budget beyond its daily videos goes to paid campaigns of our content; record every spend here. */
function Campaigns() {
  const [d, err, retry] = usePoll(() => api.admin.campaigns(), 30_000);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(null);
  if (err && !d) return <ErrorState error={err} retry={retry} />;
  if (!d) return <Loading />;
  const t = d.treasury || {};
  const record = async (mint) => {
    const f = form[mint] || {};
    setBusy(mint);
    try { await api.admin.adSpend(mint, Number(f.usd), f.note || ''); toast('Ad spend recorded'); setForm((x) => ({ ...x, [mint]: {} })); retry(); } catch (e) { toast(e.message, 5000); } finally { setBusy(null); }
  };
  const withdraw = async () => {
    setBusy('withdraw');
    try { const r = await api.admin.withdraw(); toast(r.result === 'ok' ? `Sent ${(Number(r.lamports) / 1e9).toFixed(4)} SOL` : `Withdraw ${r.result}`, 5000); retry(); } catch (e) { toast(e.message, 5000); } finally { setBusy(null); }
  };
  return (
    <div className="stack">
      <div className="card pad stack">
        <b>Reminder</b>
        <span className="small muted">Every coin makes at most {d.videosPerDay} videos a day. The rest of its budget is for paid campaigns of our content on X and TikTok, bonded coins first: never the coin, a price or its contract address. Run the campaign in X Pumpfun Ads or TikTok Pumpfun Ads Manager, then record what it cost below so it shows on the coin's spend log.</span>
      </div>
      <div className="card pad row between wrap">
        <div className="stack" style={{ gap: 4 }}>
          <b>Treasury</b>
          <span className="small muted">{t.sol != null ? `${t.sol} SOL` : 'balance not read yet'} · {t.payoutTo ? `pays out to ${t.payoutTo.slice(0, 4)}…${t.payoutTo.slice(-4)}` : 'no payout wallet set'} · keeps {t.floorSol} SOL for the daily sale{t.dryRun ? ' · DRY RUN: nothing is sold or paid out yet' : ''}</span>
          <span className="small muted">After every daily sale everything above the floor goes to the payout wallet by itself. Withdraw now sends it at once.</span>
        </div>
        <button className="btn" disabled={busy === 'withdraw' || !t.payoutTo || !t.enabled} onClick={withdraw}>{busy === 'withdraw' ? 'Sending' : 'Withdraw now'}</button>
      </div>
      {!d.coins.length ? <Empty>No coin has $1 of budget yet.</Empty> : d.coins.map((c) => (
        <div className="card pad row between wrap" key={c.mint}>
          <div className="stack" style={{ gap: 4 }}>
            <b><Link href={`/t/${c.mint}`}>{c.name}</Link> <span className="sym">${c.symbol}</span>{c.bonded && <span className="badge green" style={{ marginLeft: 8 }}>Graduated</span>}</b>
            <span className="small muted">Budget {money(c.balanceUsd)} · lifetime fees {money(c.lifetimeUsd)} · videos today {c.videosToday}/{d.videosPerDay}</span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input className="input sm" style={{ width: 110 }} inputMode="decimal" placeholder="$ spent" value={form[c.mint]?.usd || ''} onChange={(e) => setForm((x) => ({ ...x, [c.mint]: { ...x[c.mint], usd: e.target.value.replace(/[^0-9.]/g, '') } }))} />
            <input className="input sm" style={{ width: 200 }} placeholder="Where (X boost, TikTok…)" value={form[c.mint]?.note || ''} onChange={(e) => setForm((x) => ({ ...x, [c.mint]: { ...x[c.mint], note: e.target.value } }))} />
            <button className="btn sm primary" disabled={busy === c.mint || !(Number(form[c.mint]?.usd) > 0)} onClick={() => record(c.mint)}>Record ad spend</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Review() {
  const [d, err, retry] = usePoll(() => api.admin.review(), 30_000);
  const [busy, setBusy] = useState(null);
  const act = async (id, fn, msg) => {
    setBusy(id);
    try { await fn(); toast(msg); retry(); } catch (e) { toast(e.message); } finally { setBusy(null); }
  };
  if (err && !d) return <ErrorState error={err} retry={retry} />;
  if (!d) return <Loading />;
  if (!d.items?.length) return <Empty>Nothing waiting for review.</Empty>;
  return (
    <div className="admin-grid">
      {d.items.map((it) => (
        <div className="card admin-item" key={it.id}>
          <Media item={it} controls />
          <div className="pad stack">
            <div className="row between small"><Link href={`/t/${it.mint}`}><b>${it.symbol}</b> {it.name}</Link><span className="muted">{it.step} · {ago(it.createdAt)}</span></div>
            {it.caption && <p className="small" style={{ margin: 0 }}>{it.caption}</p>}
            {it.moderation && <div className={`small ${/flag|fail|block/i.test(it.moderation) ? 'bad-text' : 'muted'}`}>Moderation: {typeof it.moderation === 'string' ? it.moderation : JSON.stringify(it.moderation)}</div>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm primary" disabled={busy === it.id} onClick={() => act(it.id, () => api.admin.approve(it.id), 'Approved')}>Approve</button>
              <button className="btn sm" disabled={busy === it.id} onClick={() => { const r = prompt('Reason (optional)') ?? null; if (r !== null) act(it.id, () => api.admin.reject(it.id, r), 'Rejected'); }}>Reject</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TikTok() {
  const [d, err, retry] = usePoll(() => api.admin.tiktok(), 30_000);
  const [urls, setUrls] = useState({});
  const [busy, setBusy] = useState(null);
  const mark = async (id) => {
    setBusy(id);
    try { await api.admin.markPosted(id, urls[id] || ''); toast('Marked posted'); retry(); } catch (e) { toast(e.message); } finally { setBusy(null); }
  };
  if (err && !d) return <ErrorState error={err} retry={retry} />;
  if (!d) return <Loading />;
  if (!d.items?.length) return <Empty>Nothing to post on TikTok.</Empty>;
  return (
    <div className="admin-grid">
      {d.items.map((it) => (
        <div className="card admin-item" key={it.id}>
          <Media item={{ kind: 'image', ...it, url: it.thumb || it.url }} />
          <div className="pad stack">
            <div className="row between small"><Link href={`/t/${it.mint}`}><b>${it.symbol}</b> {it.name}</Link><span className="muted">{ago(it.createdAt)}</span></div>
            {it.caption && <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{it.caption}</p>}
            <div className="row wrap" style={{ gap: 8 }}>
              <a className="btn sm" href={it.url} download target="_blank" rel="noreferrer">Download</a>
              {it.caption && <button className="btn sm" onClick={() => navigator.clipboard?.writeText(it.caption).then(() => toast('Caption copied'), () => {})}>Copy caption</button>}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input sm" placeholder="TikTok post URL" value={urls[it.id] || ''} onChange={(e) => setUrls((u) => ({ ...u, [it.id]: e.target.value }))} />
              <button className="btn sm primary" disabled={busy === it.id || !/^https?:\/\//.test(urls[it.id] || '')} onClick={() => mark(it.id)}>Mark posted</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const [token, setToken] = useState('');
  const [probe, perr] = usePoll(() => api.admin.overview(), 0);
  const denied = perr && (perr.status === 401 || perr.status === 403);
  return (
    <div className="page">
      <div className="page-head">
        <div><div className="eyebrow">Operator</div><h1 className="display sm">Admin</h1></div>
        {!denied && <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>}
      </div>
      {denied ? (
        <form className="card pad stack narrow-form" onSubmit={(e) => { e.preventDefault(); if (token) location.href = api.admin.loginUrl(token.trim()); }}>
          <b>Admin sign in</b>
          <span className="small muted">Paste the admin token. It sets a cookie and brings you back here.</span>
          <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" autoComplete="off" />
          <button className="btn primary" disabled={!token}>Sign in</button>
        </form>
      ) : !probe && !perr ? <Loading /> : tab === 'overview' ? <Overview /> : tab === 'review' ? <Review /> : tab === 'campaigns' ? <Campaigns /> : <TikTok />}
    </div>
  );
}
