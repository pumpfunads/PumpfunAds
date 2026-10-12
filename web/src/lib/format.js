export const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '');
export function usd(n, { compact = true } = {}) {
  if (n == null || !Number.isFinite(n)) return '–';
  if (compact && Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (compact && Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  // Three significant figures, as Pumpfun shows them: $1.13k, $11.5k, $134k (a market cap must read the same on both).
  if (compact && Math.abs(n) >= 1e3) { const k = n / 1e3; return `$${k.toFixed(Math.abs(k) >= 100 ? 0 : Math.abs(k) >= 10 ? 1 : 2)}k`; }
  if (Math.abs(n) > 0 && Math.abs(n) < 0.0001) return `$${n.toPrecision(3)}`; // a token price: $0.00000323, never $0.0000
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** A token amount: 1.2B, 34.5M, 12.3k, 512.4, 0.0042. */
export function amount(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (a >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a === 0) return '0';
  return n.toPrecision(3);
}
/** A round dollar figure for prose: $375, $1.3k, $1.25 (small amounts keep cents). */
export function money(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`; // prose keeps round figures ($1.2k, $375)
  if (n >= 10) return `$${Math.round(n)}`;
  return `$${n.toFixed(2).replace(/\.00$/, '')}`;
}
export function ago(iso) {
  if (!iso) return '–';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
