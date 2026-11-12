import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './test-db.mjs';

useTestDatabase('ff_order');
const { reachableOrder } = await import('../src/engine.js');

const c = (from, to) => ({ from, to });

test('steps run after the steps that feed them, and unreachable steps are left out', () => {
  const conns = [c('t', 'a'), c('t', 'b'), c('a', 'm'), c('b', 'm'), c('x', 'y')];
  const order = reachableOrder([], conns, 't');
  assert.deepEqual([order[0], order.at(-1)], ['t', 'm']);
  assert.equal(order.length, 4);
  assert.equal(reachableOrder([], conns, 't'), order); // the same connections give the remembered answer
});

test('a loop is refused with a clear message', () => {
  assert.throws(() => reachableOrder([], [c('t', 'a'), c('a', 'b'), c('b', 'a')], 't'), /loop/);
});
