import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll, PLATFORM } from '../lib/data.js';
import { Link } from '../lib/router.js';
import { CoinCard, PlatformIcon, Loading, ErrorState, Empty } from '../components/ui.jsx';
import { ISearch } from '../components/Icons.jsx';

/* Two boards, as justearn.money/explore: Graduated (Market cap, Fees) and All launches (Recent, Market cap, Fees). */
const PER = 24;
const SORT_LABEL = { new: 'Recent', mcap: 'Market cap', fees: 'Fees' };
const FILTERS = ['', 'x', 'tiktok'];

function Launches({ title, sorts, graduated = false, search = false, empty }) {
  const [sort, setSort] = useState(sorts[0]);
  const [platform, setPlatform] = useState('');
  const [count, setCount] = useState(PER);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => { clearTimeout(t); };
  }, [text]);
  const [d, err, retry] = usePoll(() => api.coins({ sort, q, graduated, platform, limit: count }), 30_000, [sort, q, graduated, platform, count]);
  const coins = d?.coins;
  const reset = () => setCount(PER);
  return (
    <section className="ex-sec">
      <div className="section-head ex-toolbar">
        <h2 className="display sm">{title}</h2>
        <div className="tabs" role="tablist">
          {sorts.map((s) => <button key={s} role="tab" aria-selected={sort === s} className={sort === s ? 'on' : ''} onClick={() => { setSort(s); reset(); }}>{SORT_LABEL[s]}</button>)}
        </div>
      </div>
      <div className="ex-filters">
        <div className="chips">
          {FILTERS.map((p) => (
            <button type="button" key={p || 'all'} className={`chip ${platform === p ? 'on' : ''}`} onClick={() => { setPlatform(p); reset(); }}>
              {p && <PlatformIcon p={p} size={12} />}{p ? PLATFORM[p] : 'All'}
            </button>
          ))}
        </div>
        {search && <label className="search"><ISearch size={16} /><input aria-label="Search coins" placeholder="Search name, ticker or address" value={text} onChange={(e) => { setText(e.target.value); reset(); }} /></label>}
      </div>
      {err && !coins ? <ErrorState error={err} retry={retry} title="Coins did not load" />
        : !coins ? <Loading />
        : coins.length === 0 ? <Empty>{q ? `No coin matches "${q}".` : empty}</Empty>
        : <div className="grid coins">{coins.map((c) => <CoinCard key={c.mint} c={c} />)}</div>}
      {d && d.total > (coins?.length || 0) && count < 200 && <div className="center" style={{ marginTop: 18 }}><button type="button" className="btn" onClick={() => setCount((c) => c + PER)}>Show more</button></div>}
    </section>
  );
}

export default function Explore() {
  return (
    <div className="page">
      <div className="page-head centered">
        <div>
          <h1 className="display">Explore</h1>
          <p className="lede">Every token launched on our platform.</p>
        </div>
      </div>
      <Launches title="Graduated" sorts={['mcap', 'fees']} graduated empty="Coins appear here once they bond." />
      <Launches title="All launches" sorts={['new', 'mcap', 'fees']} search empty={<>No coins yet. <Link href="/launch">Launch the first one</Link>.</>} />
    </div>
  );
}
