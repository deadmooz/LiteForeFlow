import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase, dropTestSchema } from './test-db.mjs';

// Fake Slack and Telegram, plus a tiny mail server, so every delivery path is exercised for real.
const slackSeen = []; const telegramSeen = []; const mails = [];
const fakeApi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/slack/chat.postMessage') {
      slackSeen.push({ auth: req.headers.authorization, ...json });
      return res.end(JSON.stringify(json.channel === '#missing' ? { ok: false, error: 'channel_not_found' } : { ok: true, channel: 'C1', ts: '1.1' }));
    }
    const m = /^\/telegram\/bot([^/]+)\/sendMessage$/.exec(req.url);
    if (m) {
      telegramSeen.push({ token: m[1], ...json });
      if (String(json.chat_id) === '999') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' })); }
      return res.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }
    res.statusCode = 404; return res.end('{}');
  });
});
const smtp = net.createServer((sock) => {
  let data = ''; let inData = false; let msg = '';
  const say = (s) => sock.write(`${s}\r\n`);
  say('220 test ESMTP');
  sock.on('data', (chunk) => {
    data += chunk.toString();
    for (;;) {
      if (inData) {
        const end = data.indexOf('\r\n.\r\n');
        if (end < 0) return;
        msg += data.slice(0, end); data = data.slice(end + 5); inData = false; mails.push(msg); msg = ''; say('250 queued');
      } else {
        const nl = data.indexOf('\r\n');
        if (nl < 0) return;
        const line = data.slice(0, nl); data = data.slice(nl + 2);
        if (/^(EHLO|HELO)/i.test(line)) say('250 test');
        else if (/^DATA/i.test(line)) { inData = true; say('354 go'); }
        else if (/^QUIT/i.test(line)) { say('221 bye'); sock.end(); return; }
        else say('250 OK');
      }
    }
  });
});
await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${fakeApi.address().port}`;

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-alerts-'));
process.env.LITEFOREFLOW_SECRET = 'alerts-test-secret';
// Postgres always; Redis/BullMQ too when TEST_REDIS_URL is set.
const RUN_ID = Math.random().toString(36).slice(2, 8);
const PG_SCHEMA = useTestDatabase('ff_alerts');
if (process.env.TEST_REDIS_URL) { process.env.REDIS_URL = process.env.TEST_REDIS_URL; process.env.QUEUE_NAME = `ff-alerts-${RUN_ID}`; }
process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';
process.env.SLACK_API_URL = `${apiBase}/slack`;
process.env.TELEGRAM_API_URL = `${apiBase}/telegram`;

const { createApp } = await import('../src/app.js');
const { startWorker, startEvents, closeQueue, queueMode } = await import('../src/queue.js');
const { closeDb, run } = await import('../src/db.js');
const { sanitizeAlerts } = await import('../src/alerts.js');

let server; let base; let token; let n = 0;
const call = async (method, url, body, raw = false) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, data: raw ? text : (text ? JSON.parse(text) : {}) };
};
const settle = () => new Promise((r) => setTimeout(r, 150)); // the alert is sent just after the run answers

before(async () => {
  console.log(`# stack under test: queue=${queueMode}`);
  await startWorker();
  if (queueMode === 'bullmq') await startEvents();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  token = (await call('POST', '/api/auth/signup', { email: 'alerts@example.com', password: 'alerts-password' })).data.token;
  await run("UPDATE workspaces SET plan = 'team'"); // the free plan allows five active workflows and these tests create more
});
after(async () => { server?.close(); fakeApi.close(); smtp.close(); await closeQueue(); await closeDb(); await dropTestSchema(PG_SCHEMA); });

const credential = async (type, data) => (await call('POST', '/api/credentials', { name: `${type} ${++n}`, type, data })).data.id;
const slackCred = () => credential('slackApi', { token: 'xoxb-test' });
const telegramCred = () => credential('telegramApi', { token: '123:ABC' });
const smtpCred = () => credential('smtp', { host: '127.0.0.1', port: String(smtp.address().port), from: 'alerts@liteforeflow.test' });

/** A workflow that always fails at the step named "Explode"; active, answering on its own webhook. */
async function brokenFlow(name, alerts) {
  const path = `alerts-${++n}-${Math.random().toString(36).slice(2, 6)}`;
  const definition = {
    nodes: [
      { id: 't', type: 'trigger.webhook', name: 'Hook', parameters: { path, method: 'POST', respond: 'lastNode' }, position: { x: 0, y: 0 } },
      { id: 'c', type: 'data.code', name: 'Explode', parameters: { mode: 'runOnce', code: 'throw new Error("kaboom");' }, position: { x: 200, y: 0 } },
    ],
    connections: [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }],
  };
  const created = await call('POST', '/api/workflows', { name, definition, settings: alerts ? { alerts } : {} });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal((await call('POST', `/api/workflows/${created.data.id}/activate`)).status, 200);
  const fire = async () => { const r = await fetch(`${base}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await r.text(); await settle(); return r.status; };
  return { id: created.data.id, fire };
}

test('alert settings are checked: unknown channel, missing pieces, bad email list and bad Telegram id', () => {
  assert.throws(() => sanitizeAlerts({ enabled: true, channel: 'pager' }), /email, Slack or Telegram/);
  assert.throws(() => sanitizeAlerts({ enabled: true, channel: 'slack', credentialId: '' }), /Slack connection/);
  assert.throws(() => sanitizeAlerts({ enabled: true, channel: 'slack', credentialId: 'x', to: '' }), /Slack channel/);
  assert.throws(() => sanitizeAlerts({ enabled: true, channel: 'email', credentialId: 'x', to: 'not-an-address' }), /valid email/);
  assert.throws(() => sanitizeAlerts({ enabled: true, channel: 'email', credentialId: 'x', to: 'a@b.co, b@b.co, c@b.co, d@b.co, e@b.co, f@b.co' }), /up to five/);
  assert.throws(() => sanitizeAlerts({ enabled: true, channel: 'telegram', credentialId: 'x', to: 'me' }), /chat ID/);
  assert.equal(sanitizeAlerts({ enabled: false, channel: 'email' }).enabled, false, 'an unfinished form can be saved while alerts are off');
  assert.equal(sanitizeAlerts({ enabled: true, channel: 'email', credentialId: 'x', to: 'a@b.co;  b@b.co' }).to, 'a@b.co, b@b.co');
  assert.equal(sanitizeAlerts({ enabled: true, channel: 'telegram', credentialId: 'x', to: '-100123' }).to, '-100123');
});

test('saving refuses a connection of the wrong kind and says what to do', async () => {
  const wrong = await slackCred();
  const r = await call('POST', '/api/workflows', { name: 'x', settings: { alerts: { enabled: true, channel: 'email', credentialId: wrong, to: 'me@example.com' } } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /email connection for alerts cannot be used/i);
  const gone = await call('POST', '/api/workflows', { name: 'x', settings: { alerts: { enabled: true, channel: 'slack', credentialId: 'nope', to: '#ops' } } });
  assert.equal(gone.status, 400);
});

test('Slack: an unattended failure posts one message with the workflow, the step, the problem and a link', async () => {
  slackSeen.length = 0;
  const cred = await slackCred();
  const wf = await brokenFlow('Boom flow', { enabled: true, channel: 'slack', credentialId: cred, to: '#ops' });
  assert.equal(await wf.fire(), 500, 'the webhook caller still gets the failure');
  assert.equal(slackSeen.length, 1);
  const m = slackSeen[0];
  assert.equal(m.auth, 'Bearer xoxb-test');
  assert.equal(m.channel, '#ops');
  assert.match(m.text, /"Boom flow" failed/); assert.match(m.text, /Step: Explode/); assert.match(m.text, /kaboom/); assert.match(m.text, new RegExp(`/workflows/${wf.id}`));
});

test('alerts off, a successful run and an editor run send nothing', async () => {
  slackSeen.length = 0;
  const cred = await slackCred();
  const off = await brokenFlow('Quiet flow', { enabled: false, channel: 'slack', credentialId: cred, to: '#ops' });
  await off.fire();
  const watched = await brokenFlow('Watched flow', { enabled: true, channel: 'slack', credentialId: cred, to: '#ops' });
  const def = (await call('GET', `/api/workflows/${watched.id}`)).data.definition;
  const manual = await call('POST', `/api/workflows/${watched.id}/run`, { definition: def });
  assert.equal(manual.data.status, 'error');
  await settle();
  assert.equal(slackSeen.length, 0, JSON.stringify(slackSeen));
});

test('cooldown: a storm of failures sends one alert, then the next one says how many were held back', async () => {
  slackSeen.length = 0;
  const cred = await slackCred();
  const wf = await brokenFlow('Storm flow', { enabled: true, channel: 'slack', credentialId: cred, to: '#ops' });
  for (let i = 0; i < 3; i += 1) await wf.fire();
  assert.equal(slackSeen.length, 1, 'three failures in a row, one message');
  assert.equal((await call('GET', `/api/workflows/${wf.id}/alerts/status`)).data.held, 2);
  await run("UPDATE alert_state SET last_sent = '2000-01-01T00:00:00.000Z' WHERE workflow_id = ?", wf.id); // the cooldown has passed
  await wf.fire();
  assert.equal(slackSeen.length, 2);
  assert.match(slackSeen[1].text, /2 more failures since the last alert/);
});

test('Telegram and email deliver too', async () => {
  telegramSeen.length = 0; mails.length = 0;
  const tg = await brokenFlow('Telegram flow', { enabled: true, channel: 'telegram', credentialId: await telegramCred(), to: '4242' });
  await tg.fire();
  assert.equal(telegramSeen.length, 1);
  assert.equal(telegramSeen[0].token, '123:ABC'); assert.equal(String(telegramSeen[0].chat_id), '4242'); assert.match(telegramSeen[0].text, /"Telegram flow" failed/);

  const mail = await brokenFlow('Mail flow', { enabled: true, channel: 'email', credentialId: await smtpCred(), to: 'boss@example.com, me@example.com' });
  await mail.fire();
  await settle();
  assert.equal(mails.length, 1, 'one email');
  assert.match(mails[0], /Subject: Failed: Mail flow/); assert.match(mails[0], /boss@example\.com/); assert.match(mails[0], /kaboom/);
});

test('the test button reports success, and explains the usual mistakes in plain words', async () => {
  slackSeen.length = 0;
  const flow = await brokenFlow('Test flow', undefined);
  const cred = await slackCred();
  const ok = await call('POST', `/api/workflows/${flow.id}/alerts/test`, { alerts: { channel: 'slack', credentialId: cred, to: '#ops' } });
  assert.equal(ok.data.ok, true);
  assert.match(slackSeen[0].text, /test alert/i);
  const noChannel = await call('POST', `/api/workflows/${flow.id}/alerts/test`, { alerts: { channel: 'slack', credentialId: cred, to: '#missing' } });
  assert.equal(noChannel.data.ok, false);
  assert.match(noChannel.data.message, /cannot find the channel #missing.*invite the bot/i);
  const noChat = await call('POST', `/api/workflows/${flow.id}/alerts/test`, { alerts: { channel: 'telegram', credentialId: await telegramCred(), to: '999' } });
  assert.equal(noChat.data.ok, false);
  assert.match(noChat.data.message, /Send your bot a message first/i);
  const nothing = await call('POST', `/api/workflows/${flow.id}/alerts/test`, {});
  assert.equal(nothing.data.ok, false);
});

test('a broken alert never breaks the run, and the editor can show why it was not delivered', async () => {
  const cred = await slackCred();
  const wf = await brokenFlow('Unlucky flow', { enabled: true, channel: 'slack', credentialId: cred, to: '#missing' });
  assert.equal(await wf.fire(), 500, 'the run still answers normally');
  const st = (await call('GET', `/api/workflows/${wf.id}/alerts/status`)).data;
  assert.ok(st.lastSent);
  assert.match(st.lastError, /cannot find the channel #missing/);
});
