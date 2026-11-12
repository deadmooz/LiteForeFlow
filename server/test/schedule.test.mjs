import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildCron, parseCron, describe, runsPerDay, MINUTE_STEPS, HOUR_STEPS, DEFAULTS } from '../../web/src/schedule.js';

const cron = createRequire(import.meta.url)('node-cron');

test('every friendly schedule becomes a valid cron expression that reads back the same', () => {
  const all = [];
  for (const every of MINUTE_STEPS) all.push({ mode: 'minutes', every });
  for (const every of HOUR_STEPS) for (const minute of [0, 5, 59]) all.push({ mode: 'hours', every, minute });
  for (const time of ['00:00', '09:30', '23:59']) all.push({ mode: 'day', time });
  for (const days of [[1, 2, 3, 4, 5], [0, 6], [3], [1, 3, 5]]) all.push({ mode: 'week', days, time: '07:15' });
  for (const date of [1, 15, 28]) all.push({ mode: 'month', date, time: '06:00' });
  for (const s of all) {
    const expr = buildCron(s);
    assert.ok(cron.validate(expr), `${JSON.stringify(s)} -> "${expr}" is not valid cron`);
    assert.deepEqual(parseCron(expr), s, `"${expr}" did not read back as ${JSON.stringify(s)}`);
  }
});

test('picking all seven days is the same as every day', () => {
  assert.equal(buildCron({ mode: 'week', days: [0, 1, 2, 3, 4, 5, 6], time: '07:15' }), '15 7 * * *');
});

test('known cron strings are understood, including the ones shipped in the templates', () => {
  assert.deepEqual(parseCron('0 9 * * 1-5'), { mode: 'week', days: [1, 2, 3, 4, 5], time: '09:00' });
  assert.deepEqual(parseCron('0 * * * *'), { mode: 'hours', every: 1, minute: 0 });
  assert.deepEqual(parseCron('0 7 * * *'), { mode: 'day', time: '07:00' });
  assert.deepEqual(parseCron('0 8 * * 7'), { mode: 'week', days: [0], time: '08:00' }); // 7 = Sunday
  assert.deepEqual(parseCron('* * * * *'), { mode: 'minutes', every: 1 });
});

test('anything the simple controls cannot express falls back to Advanced instead of being changed', () => {
  for (const odd of ['*/7 * * * *', '0 9 1,15 * *', '0 9 31 * *', '0 9 * 6 *', '0 0 9 * * *', 'MON', '', '0 9-17 * * *', '0 25 * * *', '0 9 * * MON']) {
    assert.equal(parseCron(odd), null, `"${odd}" should stay a custom expression`);
  }
});

test('descriptions are plain English', () => {
  assert.equal(describe(parseCron('0 9 * * 1-5')), 'Every weekday at 9:00 AM');
  assert.equal(describe(parseCron('30 18 * * *')), 'Every day at 6:30 PM');
  assert.equal(describe(parseCron('0 0 * * 0,6')), 'Every weekend day at 12:00 AM');
  assert.equal(describe(parseCron('0 12 * * 1,3')), 'Every Monday, Wednesday at 12:00 PM');
  assert.equal(describe(parseCron('*/15 * * * *')), 'Every 15 minutes');
  assert.equal(describe(parseCron('0 */2 * * *')), 'Every 2 hours, at the start of the hour');
  assert.equal(describe(parseCron('0 8 2 * *')), 'On the 2nd of every month at 8:00 AM');
  assert.equal(describe(parseCron('0 8 22 * *')), 'On the 22nd of every month at 8:00 AM');
});

test('incomplete choices produce no schedule, and frequent runs are counted', () => {
  assert.equal(buildCron({ mode: 'week', days: [], time: '09:00' }), null);
  assert.equal(runsPerDay({ mode: 'minutes', every: 5 }), 288);
  assert.equal(runsPerDay(DEFAULTS.day), 0);
});
