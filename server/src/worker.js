// Convenience entry point: `node src/worker.js` == LITEFOREFLOW_ROLE=worker node src/index.js
process.env.LITEFOREFLOW_ROLE = 'worker';
await import('./index.js');
