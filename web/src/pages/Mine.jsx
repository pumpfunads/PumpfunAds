import { api } from '../lib/api.js';
import { useState } from 'react';
import { usePoll } from '../lib/data.js';
import { useWallet } from '../lib/wallet.jsx';
import { Link } from '../lib/router.js';
import { usd, money } from '../lib/format.js';
import { TokenIcon, Progress, WalletButton, Loading, ErrorState, Empty } from '../components/ui.jsx';

export default function Mine() {
  const w = useWallet();
  const [d, err, retry] = usePoll(() => (w.signedIn ? api.mine() : Promise.resolve(null)), 60_000, [w.signedIn]);
  const coins = d?.coins;
  return (
    <div className="page">
      <div className="page-head centered">
        <div>
          <h1 className="display">Your launches</h1>
          <p className="lede">Each coin's ad budget and what it unlocks next.</p>
        </div>
      </div>
      {!w.signedIn ? (
        <div className="card state"><b>Sign in to see your coins</b><span className="muted small">Connect the wallet you launched from.</span><WalletButton big /></div>
      ) : err && !coins ? <ErrorState error={err} retry={retry} title="Your coins did not load" />
        : !coins ? <Loading />
        : coins.length === 0 ? <Empty>No launches from this wallet yet. <Link href="/launch">Launch your first coin</Link>.</Empty>
        : (
          <div className="stack">
            {coins.map((c) => {
              if (c.status === 'created') return <Unfinished key={c.mint} c={c} onDone={retry} />;
              const b = c.budget || {};
              const grad = c.phase === 'graduated';
              return (
                <Link key={c.mint} href={`/t/${c.mint}`} className="card mine-row">
                  <TokenIcon src={c.image} label={c.symbol} size={56} />
                  <div className="min0 mine-id">
                    <div className="coin-name">{c.name}</div>
                    <div className="sym">${c.symbol}</div>
                  </div>
                  <div className="mine-cell"><span className="muted small">Market cap</span><b className="mono">{usd(c.marketCapUsd)}</b><Progress value={c.progress} graduated={grad} /></div>
                  <div className="mine-cell"><span className="muted small">Budget</span><b className="mono">{money(b.balanceUsd ?? 0)}</b><span className="small muted">{money(c.feesUsd ?? b.lifetimeUsd ?? 0)} lifetime fees</span></div>
                  <div className="mine-cell"><span className="muted small">Next unlock</span><b>{b.nextStep ? b.nextStep.label : grad ? 'Bonding campaigns' : '–'}</b><span className="small muted">{b.nextStep ? `in ${money(b.nextStep.remainingUsd)} of fees` : ''}</span></div>
                </Link>
              );
            })}
          </div>
        )}
    </div>
  );
}

/** A launch that was sent but never confirmed as live here (the tab closed, the network dropped): finish it or learn it never landed. */
function Unfinished({ c, onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const finish = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.relock(c.mint);
      onDone();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mine-row">
      <TokenIcon src={c.image} label={c.symbol} size={56} />
      <div className="min0 mine-id">
        <div className="coin-name">{c.name}</div>
        <div className="sym">${c.symbol}</div>
      </div>
      <div className="mine-cell"><span className="muted small">Launch</span><b>Not confirmed yet</b>{msg && <span className="small muted">{msg}</span>}</div>
      <div className="mine-cell"><button className="btn sm primary" disabled={busy} onClick={finish}>{busy ? 'Checking…' : 'Finish launch'}</button></div>
    </div>
  );
}
