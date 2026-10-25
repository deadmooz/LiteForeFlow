import cron from 'node-cron';
import { all, get, run, transaction } from './db.js';
import { getNodeType, withDefaults } from './nodes/index.js';
import { validateWorkflow } from './engine.js';
import { parseWorkflow, pruneExecutions } from './runner.js';
import { assertCanActivate } from './plans.js';
import { upsertSchedule, removeSchedule, enqueue } from './queue.js';

export class ActivationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const scheduleKey = (workflowId, nodeId) => `wf:${workflowId}:${nodeId}`;

/* -------------------------- durable schedules (cron / RSS) -------------------- */

/** Brings the queue's recurring jobs in line with the workflow's trigger nodes. Idempotent. */
async function syncSchedules(workflow) {
  const desired = new Map();
  for (const node of workflow.definition.nodes) {
    if (node.disabled) continue;
    const params = withDefaults(getNodeType(node.type) ?? {}, node.parameters);
    const base = { workflowId: workflow.id, workspaceId: workflow.workspaceId, nodeId: node.id };
    if (node.type === 'trigger.cron') {
      desired.set(scheduleKey(workflow.id, node.id), { spec: { pattern: params.cron, tz: params.timezone || 'UTC' }, payload: { kind: 'cron', ...base } });
    } else if (node.type === 'trigger.rss') {
      const minutes = Math.max(5, Number(params.intervalMinutes) || 15);
      desired.set(scheduleKey(workflow.id, node.id), { spec: { every: minutes * 60_000 }, payload: { kind: 'poll-rss', ...base }, baseline: true });
    }
  }

  const existing = new Set((await all('SELECT key FROM schedules WHERE workflow_id = ?', workflow.id)).map((r) => r.key));
  for (const key of existing) {
    if (!desired.has(key)) { await removeSchedule(key); await run('DELETE FROM schedules WHERE key = ?', key); }
  }
  for (const [key, { spec, payload, baseline }] of desired) {
    await upsertSchedule(key, spec, payload);
    if (!existing.has(key)) {
      await run('INSERT INTO schedules (key, workflow_id) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', key, workflow.id);
      if (baseline) await enqueue(payload); // record the feed's current entries right away
    }
  }
}

async function clearSchedules(workflowId) {
  for (const r of await all('SELECT key FROM schedules WHERE workflow_id = ?', workflowId)) await removeSchedule(r.key);
  await run('DELETE FROM schedules WHERE workflow_id = ?', workflowId);
}

/* ----------------------------- activation lifecycle --------------------------- */

/** Validates, registers webhooks, starts schedules and flips `active`. */
export async function activateWorkflow(workflow) {
  const issues = validateWorkflow(workflow.definition);
  if (issues.length) throw new ActivationError(`Cannot activate: ${issues[0]}`);
  await assertCanActivate(workflow.workspaceId, workflow.active);

  const webhooks = [];
  for (const node of workflow.definition.nodes) {
    const params = withDefaults(getNodeType(node.type) ?? {}, node.parameters);
    if (node.type === 'trigger.cron' && !cron.validate(params.cron)) {
      throw new ActivationError(`Node "${node.name}" has an invalid cron expression`);
    }
    if (node.type === 'trigger.webhook' && !node.disabled) {
      const path = String(params.path || '').replace(/^\/+|\/+$/g, '');
      if (!path) throw new ActivationError(`Webhook node "${node.name}" needs a path`);
      const clash = await get(
        params.method === 'ANY'
          ? 'SELECT workflow_id FROM webhooks WHERE path = ? AND workflow_id != ?'
          : "SELECT workflow_id FROM webhooks WHERE path = ? AND workflow_id != ? AND method IN (?, 'ANY')",
        ...(params.method === 'ANY' ? [path, workflow.id] : [path, workflow.id, params.method]),
      );
      if (clash) throw new ActivationError(`Webhook path "${path}" is already used by another workflow`);
      webhooks.push({ path, method: params.method, nodeId: node.id });
    }
  }

  try {
    await syncSchedules(workflow);
  } catch (e) {
    throw new ActivationError(`Cannot activate: schedule could not be created (${e.message})`);
  }
  try {
    await transaction(async (tx) => {
      await tx.run('DELETE FROM webhooks WHERE workflow_id = ?', workflow.id);
      for (const w of webhooks) {
        await tx.run('INSERT INTO webhooks (path, method, workflow_id, node_id) VALUES (?,?,?,?)', w.path, w.method, workflow.id, w.nodeId);
      }
      await tx.run('UPDATE workflows SET active = 1 WHERE id = ?', workflow.id);
    });
  } catch (e) {
    await clearSchedules(workflow.id).catch(() => {});
    throw new ActivationError(/unique|duplicate|constraint/i.test(e.message) ? 'A webhook path is already in use by another workflow' : e.message);
  }
}

export async function deactivateWorkflow(workflowId) {
  await clearSchedules(workflowId);
  await run('DELETE FROM webhooks WHERE workflow_id = ?', workflowId);
  await run('UPDATE workflows SET active = 0 WHERE id = ?', workflowId);
}

/** On boot (API / all roles): re-arm every active workflow's schedules and drop orphans. Safe to run on many instances. */
export async function initScheduler() {
  for (const row of await all('SELECT * FROM workflows WHERE active = 1')) {
    const wf = parseWorkflow(row);
    try { await syncSchedules(wf); } catch (e) { console.error(`[scheduler] could not start "${wf.name}":`, e.message); }
  }
  const orphans = await all(
    'SELECT s.key FROM schedules s LEFT JOIN workflows w ON w.id = s.workflow_id WHERE w.id IS NULL OR w.active = 0',
  );
  for (const o of orphans) {
    await removeSchedule(o.key).catch(() => {});
    await run('DELETE FROM schedules WHERE key = ?', o.key);
  }
  const sweep = () => pruneExecutions().catch((e) => console.error('[prune]', e.message));
  const timer = setInterval(sweep, 3_600_000);
  timer.unref();
  await sweep();
  return () => clearInterval(timer);
}
