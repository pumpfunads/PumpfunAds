import { Component, useEffect, useState } from 'react';
import { WalletProvider } from './lib/wallet.jsx';
import { ConfigCtx, FALLBACK_CONFIG } from './lib/data.js';
import { usePath } from './lib/router.js';
import { api } from './lib/api.js';
import { Shell } from './components/Shell.jsx';
import { WalletPicker, Toast } from './components/ui.jsx';
import Feed from './pages/Feed.jsx';
import Home from './pages/Home.jsx';
import Launch from './pages/Launch.jsx';
import Explore from './pages/Explore.jsx';
import Coin from './pages/Coin.jsx';
import Mine from './pages/Mine.jsx';
import How from './pages/How.jsx';
import Admin from './pages/Admin.jsx';

const COIN = /^\/(t|coin|c)\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/;

/** One page failing must never blank the site: the sidebar and the other pages keep working. */
class PageBoundary extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.path !== this.props.path && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="page narrow"><h1 className="display sm">Something went wrong on this page</h1><p className="muted">Reload to try again.</p><button className="btn" onClick={() => location.reload()}>Reload</button></div>;
  }
}
function Page({ path }) {
  if (path === '/feed') return <Feed />;
  if (path === '/launch') return <Launch />;
  if (path === '/explore') return <Explore />;
  if (path === '/mine') return <Mine />;
  if (path === '/how' || path === '/docs') return <How />;
  if (path === '/admin') return <Admin />;
  const m = path.match(COIN);
  if (m) {
    // /t/<mint> is the coin page (as Shill, Switch, Hooker); /coin/ and /c/ are old addresses.
    if (m[1] !== 't') history.replaceState(null, '', `/t/${m[2]}${location.search}${location.hash}`);
    return <Coin mint={m[2]} />;
  }
  return <div className="page narrow"><h1 className="display sm">Not found</h1><p className="muted">There is nothing at {path}.</p></div>;
}

export default function App() {
  const path = usePath();
  const [cfg, setCfg] = useState(FALLBACK_CONFIG);
  // Re-read every 20 s: when $ADS goes live (CA in the pill, launching opened) every open page follows, no reload.
  useEffect(() => {
    const pull = () => { api.config().then((c) => setCfg({ ...FALLBACK_CONFIG, ...c })).catch(() => {}); };
    pull();
    const t = setInterval(pull, 20_000);
    return () => { clearInterval(t); };
  }, []);
  return (
    <ConfigCtx.Provider value={cfg}>
      <WalletProvider>
        {/* The landing page is full width with its own nav; every other page sits in the app shell (sidebar). */}
        {path === '/' ? <PageBoundary path={path}><Home /></PageBoundary> : <Shell path={path}><PageBoundary path={path}><Page path={path} /></PageBoundary></Shell>}
        <WalletPicker />
        <Toast />
      </WalletProvider>
    </ConfigCtx.Provider>
  );
}
