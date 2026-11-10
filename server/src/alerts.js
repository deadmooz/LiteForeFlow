import { get, run, now } from './db.js';
import { config } from './config.js';
import { slackPost, telegramSend, smtpTransport } from './messaging.js';
import { loadCredential } from './credentials.js';

/*
 * "Tell me if this fails": one message by email, Slack or Telegram when a run that nobody is watching goes wrong.
 * The secrets stay where they already live (encrypted credentials); a workflow only remembers which one to use and where to send.
 * At most one alert per workflow per cooldown window, with a count of what was held back, so a broken schedule cannot flood anyone.
 */
const ALERT_CHANNELS = { email: 'smtp', slack: 'slackApi', telegram: 'telegramApi' };
const CHANNEL_NAMES = { email: 'email', slack: 'Slack', telegram: 'Telegram' };
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Validates the alert settings a client sent. Returns a clean copy (or undefined when none were sent). */
export function sanitizeAlerts(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('Alert settings are not valid');
  const out = { enabled: input.enabled === true, channel: String(input.channel ?? 'email'), credentialId: String(input.credentialId ?? '').slice(0, 100), to: String(input.to ?? '').trim().slice(0, 300) };
  if (!ALERT_CHANNELS[out.channel]) throw bad('Choose email, Slack or Telegram for alerts');
  if (!out.enabled) return out; // an unfinished form can be saved while alerts are off
  if (!out.credentialId) throw bad(`Pick the ${CHANNEL_NAMES[out.channel]} connection to send alerts with`);
  if (!out.to) throw bad(out.channel === 'email' ? 'Enter the email address to send alerts to' : out.channel === 'slack' ? 'Enter the Slack channel to post alerts in' : 'Enter the Telegram chat ID to send alerts to');
  if (out.channel === 'email') {
    const list = out.to.split(/[,;\s]+/).filter(Boolean);
    if (list.length > 5 || !list.every((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))) throw bad('Enter up to five valid email addresses, separated by commas');
    out.to = list.join(', ');
  }
  if (out.channel === 'telegram' && !/^(-?\d{1,20}|@\w{4,64})$/.test(out.to)) throw bad('A Telegram chat ID is a number such as 123456789 (a group starts with a minus sign), or @channelname');
  return out;
}

/** The chosen connection must exist in this workspace and be the right kind. Throws a plain-language 400. */
export async function assertAlertsUsable(workspaceId, alerts) {
  if (!alerts?.enabled) return;
  try { await loadCredential(workspaceId, alerts.credentialId, ALERT_CHANNELS[alerts.channel]); } catch (e) {
    throw bad(`The ${CHANNEL_NAMES[alerts.channel]} connection for alerts cannot be used: ${e.message}`);
  }
}

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function compose(workflow, error, { suppressed = 0, test = false } = {}) {
  const link = `${config.publicUrl}/workflows/${workflow.id}`;
  if (test) {
    return { subject: `Test alert from LiteForeFlow`, text: `This is a test alert for "${workflow.name}".\nIf you can read this, failure alerts for this workflow are set up correctly.\nOpen it: ${link}` };
  }
  const lines = [
    `⚠️ "${workflow.name}" failed`,
    error?.nodeName ? `Step: ${error.nodeName}` : null,
    `Problem: ${clip(error?.message ?? 'Unknown error', 400)}`,
    `When: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    suppressed > 0 ? `${suppressed} more failure${suppressed === 1 ? '' : 's'} since the last alert.` : null,
    `Open it: ${link}`,
  ].filter(Boolean);
  return { subject: `Failed: ${clip(workflow.name, 80)}`, text: lines.join('\n') };
}

const SLACK_HINTS = {
  channel_not_found: (to) => `Slack cannot find the channel ${to}. Check the name, and invite the bot to it (type /invite @yourbot in that channel).`,
  not_in_channel: (to) => `The bot is not in ${to} yet. Type /invite @yourbot in that channel.`,
  invalid_auth: () => 'Slack rejected the token. Open Credentials and enter the bot token again.',
  token_revoked: () => 'Slack says this token was revoked. Create a new one and update the credential.',
  account_inactive: () => 'Slack says this token belongs to a deactivated account.',
};

/** Sends one message. Throws an Error whose message says what to fix. */
export async function sendMessage(channel, cred, to, { subject, text }) {
  if (channel === 'slack') {
    const data = await slackPost(cred.token, to, text, { timeoutMs: 15000 });
    if (!data?.ok) throw new Error((SLACK_HINTS[data?.error] ?? (() => `Slack said: ${data?.error ?? 'no answer'}`))(to));
    return;
  }
  if (channel === 'telegram') {
    const data = await telegramSend(cred.token, { chat_id: to, text }, { timeoutMs: 15000, ignoreStatus: true });
    if (!data?.ok) {
      const why = String(data?.description ?? 'no answer');
      throw new Error(/chat not found|bot was blocked|have no rights/i.test(why)
        ? `Telegram could not reach that chat (${why}). Send your bot a message first so it is allowed to write to you, then check the chat ID.`
        : `Telegram said: ${why}`);
    }
    return;
  }
  const transport = await smtpTransport(cred, { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  try {
    await transport.sendMail({ from: cred.from, to, subject, text });
  } catch (e) {
    if (e.code === 'EAUTH') throw new Error('The mail server refused the username or password.');
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNECTION', 'ESOCKET'].includes(e.code)) throw new Error(`Could not connect to the mail server ${cred.host}:${Number(cred.port) || 587}. Check the host and port.`);
    throw new Error(`The mail server said: ${clip(e.message, 200)}`);
  } finally { transport.close(); }
}

/** Sends a sample alert right now (ignoring the cooldown). Always resolves: { ok, message }. */
export async function testAlert(workspaceId, workflow, alerts) {
  try {
    const a = sanitizeAlerts({ ...alerts, enabled: true });
    const cred = await loadCredential(workspaceId, a.credentialId, ALERT_CHANNELS[a.channel]);
    await sendMessage(a.channel, cred, a.to, compose(workflow, null, { test: true }));
    return { ok: true, message: `Sent. Check ${a.channel === 'telegram' ? 'your Telegram chat' : a.to}.` };
  } catch (e) { return { ok: false, message: clip(e.message, 300) }; }
}

/**
 * Decides, once across every process, whether this failure may send an alert now. The first ever failure sends;
 * later ones send only after the cooldown, and the ones held back are counted so the next message can say so.
 */
async function claimSlot(workflowId) {
  const t = now();
  const cutoff = new Date(Date.now() - config.alertCooldownMs).toISOString();
  // One statement for the usual case (a row exists): lock it, then either start a new cooldown (and report how many were held back)
  // or count this one as held back. Several processes failing at once are serialised by the row lock.
  const claim = () => get(
    `WITH prev AS (SELECT suppressed, last_sent FROM alert_state WHERE workflow_id = ? FOR UPDATE),
          upd AS (UPDATE alert_state a SET
                    suppressed = CASE WHEN prev.last_sent <= ? THEN 0 ELSE a.suppressed + 1 END,
                    last_sent = CASE WHEN prev.last_sent <= ? THEN ? ELSE a.last_sent END
                  FROM prev WHERE a.workflow_id = ? RETURNING (prev.last_sent <= ?) AS send, prev.suppressed AS was)
     SELECT send, was FROM upd`, workflowId, cutoff, cutoff, t, workflowId, cutoff,
  );
  let row = await claim();
  if (!row) { // the very first failure of this workflow: it sends
    const first = await run('INSERT INTO alert_state (workflow_id, last_sent, suppressed) VALUES (?,?,0) ON CONFLICT (workflow_id) DO NOTHING', workflowId, t);
    if (first.changes) return { send: true, suppressed: 0 };
    row = await claim(); // another process inserted it a moment ago
  }
  return row?.send ? { send: true, suppressed: row.was ?? 0 } : { send: false, suppressed: 0 };
}

/** Called after an unattended run failed. Never throws into the run: a broken alert is recorded, not propagated. */
export async function notifyFailure(workflow, error) {
  const a = workflow.settings?.alerts;
  if (!a?.enabled) return;
  const slot = await claimSlot(workflow.id);
  if (!slot.send) return;
  let problem = null;
  try {
    const cred = await loadCredential(workflow.workspaceId, a.credentialId, ALERT_CHANNELS[a.channel]);
    await sendMessage(a.channel, cred, a.to, compose(workflow, error, { suppressed: slot.suppressed }));
  } catch (e) {
    problem = clip(e.message, 300);
    console.error(`[alerts] could not send the alert for "${workflow.name}": ${problem}`);
  }
  await run('UPDATE alert_state SET last_error = ? WHERE workflow_id = ?', problem, workflow.id).catch(() => {});
}

/** What the editor shows under the alert settings. */
export async function alertStatus(workflowId) {
  const row = await get('SELECT last_sent, suppressed, last_error FROM alert_state WHERE workflow_id = ?', workflowId);
  return row ? { lastSent: row.last_sent, held: row.suppressed, lastError: row.last_error ?? null } : { lastSent: null, held: 0, lastError: null };
}
