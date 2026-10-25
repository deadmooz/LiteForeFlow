// Senior-QA black-box suite. Usage: node server/test/qa/qa.mjs [--out report.json]
import fs from 'node:fs';
import path from 'node:path';
import { boot, startMock, startSmtp, results, summary, here } from './lib.mjs';
import part1 from './part1-access.mjs';
import part2 from './part2-engine.mjs';
import part3 from './part3-integrations.mjs';
import part4 from './part4-platform.mjs';

const started = Date.now();
const mock = await startMock();
const smtp = await startSmtp();
const s1 = await boot('main');
const sRate = await boot('rate', { AUTH_RATE_LIMIT_PER_MIN: '20' });
const sNoSignup = await boot('nosignup', { ALLOW_SIGNUP: 'false' });
const sBlock = await boot('block', { BLOCK_PRIVATE_NETWORK: 'true' });
const sProd = await boot('prod', { NODE_ENV: 'production' });
const sBill = await boot('bill', { STRIPE_WEBHOOK_SECRET: 'whsec_qa' });
const ctx = { s1, sRate, sNoSignup, sBlock, sProd, sBill, mock, smtp };

try {
  await part1(ctx);
  await part2(ctx);
  await part3(ctx);
  await part4(ctx);
} finally {
  for (const s of [s1, sRate, sNoSignup, sBlock, sProd, sBill]) await s.stop().catch(() => {});
  mock.close(); smtp.close();
}
const sum = summary();
console.log(`\nTOTAL ${sum.total}  PASS ${sum.pass}  FAIL ${sum.fail}  BLOCKED ${sum.blocked}  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(here, 'qa-results.json');
fs.writeFileSync(out, JSON.stringify({ summary: sum, results }, null, 2));
process.exit(0);
