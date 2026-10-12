/** Real mainnet pump coins that stand in for $ADS on the local validator: one on its curve, one graduated to PumpSwap. */
export const ADS_STANDINS = {
  curve: process.env.E2E_CURVE_Q || '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump', // a pump coin still on its curve
  pool: process.env.E2E_POOL_Q || 'Goh59QCfoX53RgJa615vzXx4swR3mv51VgvAN6ZCpump', // a pump coin graduated to PumpSwap
};
