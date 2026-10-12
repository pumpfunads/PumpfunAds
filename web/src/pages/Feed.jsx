import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Link, navigate } from '../lib/router.js';
import { ago } from '../lib/format.js';
import { TokenIcon, Media, PostedTo, Loading, ErrorState, Empty } from '../components/ui.jsx';

const PAGE = 24;

export function FeedCard({ item }) {
  return (
    <article className="card feed-card" onClick={() => navigate(`/t/${item.mint}`)}>
      <Media item={item} />
      <div className="feed-body">
        <div className="row" style={{ gap: 10 }}>
          <TokenIcon src={item.image} label={item.symbol} size={30} />
          <Link href={`/t/${item.mint}`} className="feed-coin min0" onClick={(e) => e.stopPropagation()}><b>{item.name}</b> <span className="sym">${item.symbol}</span></Link>
          <PostedTo list={item.postedTo} />
        </div>
        {item.caption && <p className="feed-caption">{item.caption}</p>}
        <div className="small muted">{ago(item.createdAt)}</div>
      </div>
    </article>
  );
}

export default function Feed() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [next, setNext] = useState(null); // the API's cursor: the id to pass as `before` for the next page
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.feed({ limit: PAGE }).then((r) => {
      if (!alive) return;
      setItems(r?.items || []);
      setNext(r?.next ?? null);
    }).catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [tick]);

  const loadMore = async () => {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.feed({ before: next, limit: PAGE });
      const got = r?.items || [];
      setItems((x) => [...x, ...got.filter((n) => !x.some((y) => y.id === n.id))]);
      setNext(got.length ? r?.next ?? null : null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head centered">
        <div>
          <h1 className="display">The feed</h1>
          <p className="lede">Everything we made and posted in one place.</p>
        </div>
      </div>

      <section>
        {error && !items ? <ErrorState error={error} retry={() => setTick((t) => t + 1)} title="The feed did not load" />
          : !items ? <Loading />
          : items.length === 0 ? <Empty>Nothing posted yet. The first launch card appears here the moment a coin launches. <Link href="/launch">Launch one</Link>.</Empty>
          : (
            <>
              <div className="masonry">{items.map((it) => <FeedCard key={it.id} item={it} />)}</div>
              {next && <div className="center" style={{ marginTop: 20 }}><button className="btn" onClick={loadMore} disabled={busy}>{busy ? 'Loading' : error ? 'Try again' : 'Load more'}</button>{error && !busy && <div className="small muted" style={{ marginTop: 8 }}>More did not load: {error.message}</div>}</div>}
            </>
          )}
      </section>
    </div>
  );
}
