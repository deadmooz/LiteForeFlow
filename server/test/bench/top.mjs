// node server/test/bench/top.mjs <dir with .cpuprofile files> [count]   -> functions with the most self time
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const count = Number(process.argv[3] ?? 18);
const file = fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas;
prof.samples.forEach((id, i) => { self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)); });
const agg = new Map();
let total = 0;
for (const [id, us] of self) {
  const n = byId.get(id);
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anonymous)'}  ${cf.url.replace(/^.*[\\/](node_modules|server)[\\/]/, '$1/').replace('file:///', '')}:${cf.lineNumber + 1}`;
  agg.set(key, (agg.get(key) ?? 0) + us);
  total += us;
}
console.log(`profile ${path.basename(file)}, ${(total / 1000).toFixed(0)} ms sampled`);
for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, count)) console.log(`${(us / 1000).toFixed(0).padStart(6)} ms ${(100 * us / total).toFixed(1).padStart(5)}%  ${k.slice(0, 120)}`);
