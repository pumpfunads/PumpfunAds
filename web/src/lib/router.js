import { createElement, useEffect, useState } from 'react';

export function navigate(to) {
  history.pushState({}, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
  if (!to.includes('#')) scrollTo({ top: 0 });
  else setTimeout(() => document.getElementById(to.split('#')[1])?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}
export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const handler = () => setPath(location.pathname);
    addEventListener('popstate', handler);
    return () => removeEventListener('popstate', handler);
  }, []);
  return path;
}
/** Same-origin links go through the router; hash links and external links behave natively. */
export function Link({ href, children, onClick: own, ...rest }) {
  // The caller's onClick runs first and the router still navigates (spreading it over ours used to reload the page).
  const onClick = (e) => {
    own?.(e);
    if (e.defaultPrevented) return;
    if (rest.target === '_blank' || /^https?:/.test(href) || href.startsWith('#') || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(href);
  };
  return createElement('a', { href, onClick, ...rest }, children);
}
