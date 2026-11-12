import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BLOCK_PRIVATE_NETWORK = 'true';
process.env.LITEFOREFLOW_ALLOW_HOST = '1';
const { httpRequest } = await import('../src/http.js');

test('private addresses are refused, as a number and as a name (checked when connecting)', async () => {
  for (const url of ['http://127.0.0.1:3999/', 'http://[::1]:3999/', 'http://localhost:3999/']) {
    await assert.rejects(httpRequest({ url, timeoutMs: 3000 }), /private or loopback/, url);
  }
});

test('an address the admin trusts is still reachable (the error is about the connection, not the block)', async () => {
  await assert.rejects(httpRequest({ url: 'http://localhost:3999/', trustedOrigin: 'http://localhost:3999', timeoutMs: 3000 }), (e) => !/private or loopback/.test(e.message));
});
