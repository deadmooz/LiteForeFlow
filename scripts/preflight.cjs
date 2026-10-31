// Runs before `npm start` and from the launchers. Plain old JavaScript on purpose: it must run (and explain
// itself) on ANY Node version, including ones too old for the app.
'use strict';

const [major, minor] = process.versions.node.split('.').map(Number);
const MIN = [22, 13];
const tooOld = major < MIN[0] || (major === MIN[0] && minor < MIN[1]);

if (tooOld) {
  console.error('');
  console.error('  LiteForeFlow needs Node.js ' + MIN.join('.') + ' or newer, but this computer has ' + process.versions.node + '.');
  console.error('');
  console.error('  Fix (takes about 2 minutes):');
  console.error('    1. Go to https://nodejs.org');
  console.error('    2. Download the "LTS" installer and run it (click Next until it finishes)');
  console.error('    3. Close this window, open a new one, and start LiteForeFlow again');
  console.error('');
  process.exit(1);
}

try {
  require('node:sqlite'); // the built-in database; no separate install needed
} catch (e) {
  console.error('\n  This Node.js build has no built-in database support. Please install the current LTS from https://nodejs.org\n');
  process.exit(1);
}

// Are all the packages from package.json really installed? `--deps` is used by the launchers: exit code 3 = please run
// `npm install`. Without the flag (npm start) the same problem is explained and stops the start.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const wantDeps = process.argv.includes('--deps') || process.env.npm_lifecycle_event === 'prestart';
const missing = !wantDeps ? [] : Object.keys(require('../package.json').dependencies || {})
  .filter((name) => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));
if (missing.length) {
  if (process.argv.includes('--deps')) process.exit(3);
  console.error('\n  The installation is incomplete (missing: ' + missing.join(', ') + ').\n  Fix: run   npm install   in this folder, then start again.\n');
  process.exit(1);
}
