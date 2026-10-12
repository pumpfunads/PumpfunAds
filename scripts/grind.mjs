/**
 * The `…ads` key grinder as its OWN process (deploy/ads-vanity.service, Nice 19, its own CPU cap), so grinding never
 * takes CPU from the API: the box has 2 cores shared by many sites. Fills the same pools in the same database
 * (api/vanity.mjs); the server runs with VANITY_GRIND=0 and only imports / issues keys.
 *   node scripts/grind.mjs   (in the app directory)
 */
import '../api/env.mjs';
import * as vanity from '../api/vanity.mjs';

process.env.VANITY_GRIND = '1';
vanity.start(console);
setInterval(() => {}, 3_600_000); // the workers are unref'd: keep the process alive
