# Pumpfun Ads

**[pumpfunads.com](https://pumpfunads.com)**: launch it, we market it.

Launch a coin on Pumpfun and let its trading fees pay for its marketing. Ads creates images, videos, a website, social
content and ad campaigns for your coin. Your coin generates the fees, and Ads turns them into content. Every credit and
every spend is visible on your coin's page.

Every coin launched here is paired with **$ADS** (Pumpfun custom pairs). Content is made with AI image and video models,
posted on [X @pumpfunads](https://x.com/pumpfunads) and [TikTok @pumpfunad](https://www.tiktok.com/@pumpfunad), and on the
creator's own accounts once the coin bonds. Full docs: [pumpfunads.com/how](https://pumpfunads.com/how).

## How it works

1. **Launch: one transaction, like Pumpfun's own.** `create_v2` paired with $ADS, plus the launcher's optional first
   buy (PumpSwap `multi_hop_swap`, SOL → $ADS → coin). The first buy's tokens go to the launcher. Nothing can land
   between the creation and the first buy. It fits Solana's 1,232 bytes through address lookup tables, and the whole
   transaction is simulated before anyone is asked to sign.
2. **Each coin has its own creator wallet.** The coin's Pumpfun creator is a fresh wallet per coin that Ads holds, so
   every creator fee (paid by Pumpfun in $ADS) arrives there. Every coin address and every creator wallet ends in `ads`.
3. **Every 5 minutes** a keeper sweeps each coin's waiting fees (bonding curve, and PumpSwap pool after graduation)
   into its creator wallet and, in the same transaction, **burns 20%** of them and sends **80%** to the treasury.
4. **Once a day** the treasury sells its $ADS for SOL through Pumpfun and credits each coin's **ad budget** with its
   exact share, in dollars. Every credit and every spend is on the coin's public page.
5. **The budget buys content, step by step:**

   | Step | Unlocks at (fees to ads) |
   |---|---|
   | Launch card | at launch, paid by Ads |
   | Content pack | $3 |
   | Video content | every $5 |
   | Bonding campaigns | at bonding |
   | The coin's own website | claimed by the creator after bonding, paid by Ads |

   The launcher picks the creator fee rate (Pumpfun standard, 0.3%, 1%, 2% or 3%). At 1%, about $375 of trading
   unlocks the content pack and about $625 the first video. A coin gets at most 5 videos a day; the rest of its budget
   funds ad campaigns of its content on X and TikTok, recorded on its spend log.
6. **What we never do:** no contract address, price or "buy" in our ads, no charts or trading screens, no brand
   impersonation. Every piece is checked before it is made and before it is posted, and reviewed by a person.

## Repository

| Path | What |
|---|---|
| `lib/pump.mjs` | Pumpfun / PumpSwap instruction builders, from Pumpfun's published IDLs (`lib/*.idl.json`). |
| `lib/ladder.mjs` | The unlock ladder: what a coin's fees buy, and when. |
| `api/` | The server: launch (prepare, simulate, relay), fee keeper, treasury, budget ledger, market reads. |
| `api/content/` | The content engine: planner, generation, moderation, posting, creator account linking. |
| `web/` | The site (React + Vite). |
| `e2e/` | End-to-end tests on a local validator with mainnet Pumpfun cloned. |
| `test/` | Unit tests. |
| `scripts/` | Lookup tables, the address grinder, operator commands. |
| `docs/CONTENT.md` | The content engine's settings and costs. |

## Run it

```sh
npm install
npm test                      # unit tests
npm run dev                   # API on :5420, site on :5421 (open /?mock for sample data)
```

End to end on a local validator (needs the Solana CLI and a mainnet RPC to clone from):

```sh
SOLANA_RPC=<mainnet rpc> node e2e/clone-list.mjs > e2e/clones.txt
CLONE_RPC_URL=<mainnet rpc> e2e/validator.sh &
node e2e/chain.mjs && node e2e/api.mjs && node e2e/graduation.mjs
```

Without API keys every content adapter runs in mock mode and labels its output as a sample.

## License

MIT, see [LICENSE](LICENSE).
