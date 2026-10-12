/**
 * The unlock ladder: what a coin's fees buy, and when. The ONE source for the planner (api/content), the coin page and
 * the launch form's preview. Thresholds count LIFETIME fees credited in USD (after the 20% $ADS burn); each step's cost
 * comes out of the coin's balance. Costs are estimates for Higgsfield + Claude + posting; the planner spends the real
 * provider estimate.
 */
export const FIRST_VIDEO_USD = 5; // operator 11 Oct: content pack at $3, a video every $5 in fees ($5, $10, $15...)
export const VIDEO_EVERY_USD = 5;

export const STEPS = [
  { key: 'launch_card', label: 'Launch card', detail: '', atUsd: 0, costUsd: 0.02, platformPays: true },
  { key: 'meme_pack', label: 'Content pack', detail: '', atUsd: 3, costUsd: 0.15 },
  { key: 'video', label: 'Video content', detail: '', atUsd: FIRST_VIDEO_USD, costUsd: 0.6, repeatEveryUsd: VIDEO_EVERY_USD },
  { key: 'trailer', label: 'Bonding campaigns', detail: '', atUsd: null, onGraduation: true, costUsd: 6 },
  { key: 'site', label: 'Your site', detail: '', atUsd: null, onGraduation: true, costUsd: 0.2 },
];

/** How many videos `lifetimeUsd` has unlocked so far. */
export const videosUnlocked = (lifetimeUsd) => (lifetimeUsd >= FIRST_VIDEO_USD ? 1 + Math.floor((lifetimeUsd - FIRST_VIDEO_USD) / VIDEO_EVERY_USD) : 0);
/** The lifetime fees at which video number `n` (1-based) unlocks. */
export const videoAtUsd = (n) => FIRST_VIDEO_USD + (n - 1) * VIDEO_EVERY_USD;

/**
 * The ladder for one coin: each step done / next / locked, and the next threshold. `done` = { [stepKey]: count made }.
 */
export function ladderFor({ lifetimeUsd = 0, graduated = false, done = {} }) {
  const steps = STEPS.map((s) => {
    let state;
    if (s.key === 'video') {
      const n = done.video || 0;
      state = n > 0 ? 'done' : lifetimeUsd >= s.atUsd ? 'next' : 'locked';
      return { ...s, state, made: n, unlocked: videosUnlocked(lifetimeUsd), nextAtUsd: videoAtUsd(Math.max(n, videosUnlocked(lifetimeUsd)) + 1) };
    }
    if (s.onGraduation) state = done[s.key] ? 'done' : graduated ? 'next' : 'locked';
    else state = done[s.key] ? 'done' : lifetimeUsd >= s.atUsd ? 'next' : 'locked';
    return { ...s, state, made: done[s.key] || 0 };
  });
  const upcoming = [
    ...STEPS.filter((s) => !s.onGraduation && s.atUsd > lifetimeUsd).map((s) => ({ key: s.key, label: s.label, atUsd: s.atUsd })),
    ...(lifetimeUsd >= FIRST_VIDEO_USD ? [{ key: 'video', label: 'Video content', atUsd: videoAtUsd(videosUnlocked(lifetimeUsd) + 1) }] : []),
  ].sort((a, b) => a.atUsd - b.atUsd);
  const next = upcoming[0] ? { ...upcoming[0], remainingUsd: Math.max(0, upcoming[0].atUsd - lifetimeUsd) } : null;
  return { steps, next };
}

/** Trading volume (USD) a coin needs for `feesUsd` of ad budget at creator fee `bps` (80% of fees fund ads). */
export const volumeFor = (feesUsd, bps) => (bps > 0 ? feesUsd / (0.8 * (bps / 10_000)) : null);
