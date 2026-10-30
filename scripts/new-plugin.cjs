// npm run plugin:new -- my-plugin      creates data/plugins/my-plugin from plugins/_template
const fs = require('node:fs');
const path = require('node:path');

const id = String(process.argv[2] || '').toLowerCase();
if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) {
  console.error('\n  Give your plugin a short name with only lowercase letters, numbers and dashes. Example:');
  console.error('    npm run plugin:new -- my-plugin\n');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const dest = path.join(dataDir, 'plugins', id);
if (fs.existsSync(dest)) {
  console.error(`\n  ${dest} already exists. Pick another name or delete that folder.\n`);
  process.exit(1);
}
const name = id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const typePrefix = id.replace(/-/g, '');
fs.mkdirSync(dest, { recursive: true });
for (const file of ['plugin.json', 'index.js']) {
  const text = fs.readFileSync(path.join(root, 'plugins', '_template', file), 'utf8')
    .replaceAll('__ID_TYPE__', typePrefix).replaceAll('__ID__', id).replaceAll('__NAME__', name);
  fs.writeFileSync(path.join(dest, file), text);
}
console.log(`\n  Created ${dest}`);
console.log('  1. Open index.js there and change the example block.');
console.log('  2. In LiteForeFlow open Plugins and press Reload (or restart it).');
console.log(`  3. Your block "Say Hello" now shows in the editor palette under Apps.\n`);
