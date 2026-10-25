import { boot, uniq } from './lib.mjs';
const PG = process.env.TEST_DATABASE_URL; const REDIS = process.env.TEST_REDIS_URL;
let fails = 0;
for (let round = 1; round <= 12; round += 1) {
  const id = uniq(); const env = { DATABASE_URL: PG, PG_SCHEMA: `race_${id}`, REDIS_URL: REDIS, QUEUE_NAME: `race-${id}` };
  const res = await Promise.allSettled([boot('a', env), boot('b', env), boot('c', env)]);
  const bad = res.filter((r) => r.status === 'rejected');
  if (bad.length) { fails += 1; console.log(`round ${round}: ${bad.length} failed:\n`, String(bad[0].reason.message).split('\n').filter((l) => /error|Error|duplicate|violates|detail/i.test(l)).slice(0, 4).join('\n')); }
  else console.log(`round ${round}: all 3 booted`);
  for (const r of res) if (r.status === 'fulfilled') await r.value.stop();
}
process.exit(fails ? 1 : 0);
