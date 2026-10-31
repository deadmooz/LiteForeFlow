// Entry point. Everything real lives in main.js; it is loaded here so that ANY start-up failure (a missing package,
// an unusable data folder, a corrupted database, a bad setting) is shown as one plain sentence instead of a stack trace.
// Set LITEFOREFLOW_DEBUG=1 to see the full details.

// A rejected promise nobody waits for (for example from user code) must never take the whole server down.
process.on('unhandledRejection', (reason) => {
  console.warn(`[liteforeflow] Ignored an unhandled promise rejection: ${reason?.message ?? reason}`);
});

function explain(e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') {
    const pkg = String(e.message).match(/package '([^']+)'/)?.[1];
    return `A required file is missing${pkg ? ` (${pkg})` : ''}. The installation looks incomplete - run:  npm install`;
  }
  if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
    return `Cannot use the data folder (${e.path ?? 'unknown'}): ${e.code}. Choose a folder you can write to, for example set DATA_DIR in the .env file.`;
  }
  if (/malformed|not a database|file is encrypted|disk image/i.test(e?.message ?? '')) {
    return 'The database file is damaged or is not a LiteForeFlow database. Your file was NOT changed. '
      + 'Restore a backup of data/liteforeflow.db, or move it away to start fresh.';
  }
  return e?.message ?? String(e);
}

try {
  await import('./main.js');
} catch (e) {
  console.error(`\n  LiteForeFlow could not start: ${explain(e)}\n`);
  if (process.env.LITEFOREFLOW_DEBUG) console.error(e);
  process.exit(1);
}
