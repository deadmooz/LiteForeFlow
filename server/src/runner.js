import os from 'node:os';
import { all, get, run, uid, now } from './db.js';
import { runWorkflow } from './engine.js';
import { reserveRun, getPlan } from './plans.js';
import { enqueue } from './queue.js';

export const workerId = `${os.hostname()}:${process.pid}`;

export function parseWorkflow(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, name: row.name, active: !!row.active,
    definition: JSON.parse(row.definition), settings: JSON.parse(row.settings || '{}'),
    staticData: JSON.parse(row.static_data || '{}'), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export const loadWorkflow = async (id, workspaceId) =>
  parseWorkflow(await get('SELECT * FROM workflows WHERE id = ? AND workspace_id = ?', id, workspaceId));

/* ------------------------------ execution records ----------------------------- */

const MAX_STORED_ITEMS = 100;
const MAX_STORED_BYTES = 1_000_000;

/** Keeps the execution log bounded so one chatty run cannot bloat the database. */
function compactResults(results) {
  let truncated = false;
  const cut = (outs) => outs?.map((items) => {
    if (items.length > MAX_STORED_ITEMS) { truncated = true; return items.slice(0, MAX_STORED_ITEMS); }
    return items;
  });
  const compact = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { ...r, input: cut(r.input), output: cut(r.output) }]));
  let json = JSON.stringify(compact);
  if (json.length > MAX_STORED_BYTES) {
    truncated = true;
    json = JSON.stringify(Object.fromEntries(Object.entries(compact).map(([id, r]) => [id, { ...r, input: undefined, output: undefined, note: 'data omitted (too large)' }])));
  }
  return { json, truncated };
}

/** Counts the run against the plan and inserts a `queued` execution row. Returns its id. */
export async function createExecution({ workflow, mode }) {
  if (mode !== 'subworkflow' && mode !== 'error') await reserveRun(workflow.workspaceId);
  const id = uid();
  await run(
    'INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at) VALUES (?,?,?,?,?,?,?)',
    id, workflow.workspaceId, workflow.id, workflow.name, 'queued', mode, now(),
  );
  return id;
}

export async function failExecution(executionId, message) {
  await run(
    "UPDATE executions SET status = 'error', finished_at = ?, error = ? WHERE id = ? AND status IN ('queued','running')",
    now(), JSON.stringify({ message }), executionId,
  );
}

/** Runs an already-created execution in this process and records the outcome. */
export async function runExecution({ executionId, workflow, mode, triggerNodeId, triggerItems, depth = 0 }) {
  const claimed = await run(
    "UPDATE executions SET status = 'running', started_at = ?, worker = ? WHERE id = ? AND status = 'queued'",
    now(), workerId, executionId,
  );
  if (!claimed.changes) return { executionId, status: 'skipped', error: null, lastOutput: [] }; // duplicate delivery or already reaped

  let result;
  try {
    result = await runWorkflow({
      workflow, mode, workspaceId: workflow.workspaceId, triggerNodeId, triggerItems,
      staticData: workflow.staticData, depth, runSubWorkflow: runSub,
    });
  } catch (e) {
    result = { status: 'error', error: { message: `Internal error: ${e.message}` }, results: {}, lastOutput: [], staticData: workflow.staticData, finishedAt: now() };
  }

  const { json, truncated } = compactResults(result.results);
  await run(
    'UPDATE executions SET status = ?, finished_at = ?, data = ?, error = ? WHERE id = ?',
    result.status, result.finishedAt, json, result.error ? JSON.stringify({ ...result.error, truncated }) : null, executionId,
  );
  await run('UPDATE workflows SET static_data = ? WHERE id = ?', JSON.stringify(result.staticData ?? {}), workflow.id);

  if (result.status === 'error' && mode !== 'error' && mode !== 'subworkflow') {
    submitErrorWorkflow(workflow, executionId, result.error).catch((e) => console.error('[error-workflow]', e.message));
  }
  return { executionId, status: result.status, error: result.error, lastOutput: result.lastOutput };
}

/** Creates and runs an execution in the current process (sub-workflows, schedules, polling). */
export async function startAndRun(opts) {
  const executionId = await createExecution(opts);
  return runExecution({ ...opts, executionId });
}

/**
 * Creates an execution and puts it on the queue. With wait:true resolves to the finished result
 * ({ executionId, status, error, lastOutput }); otherwise resolves as soon as the job is queued.
 */
export async function submitExecution(opts, { wait = false } = {}) {
  const { workflow, mode = 'manual' } = opts;
  const executionId = await createExecution({ workflow, mode });
  const payload = {
    kind: 'execute', executionId, workflowId: workflow.id, workspaceId: workflow.workspaceId, mode,
    triggerNodeId: opts.triggerNodeId, triggerItems: opts.triggerItems, definition: opts.definition, depth: opts.depth ?? 0,
  };
  try {
    const result = await enqueue(payload, { wait, jobId: executionId });
    return wait ? { ...result, executionId } : { executionId };
  } catch (e) {
    await failExecution(executionId, `Execution could not be completed: ${e.message}`).catch(() => {});
    throw e;
  }
}

async function submitErrorWorkflow(workflow, executionId, error) {
  const id = workflow.settings?.errorWorkflowId;
  if (!id || id === workflow.id) return;
  const target = await loadWorkflow(id, workflow.workspaceId);
  const trigger = target?.definition.nodes.find((n) => n.type === 'trigger.error');
  if (!trigger) return;
  await submitExecution({
    workflow: target, mode: 'error', triggerNodeId: trigger.id,
    triggerItems: [{ json: { workflow: { id: workflow.id, name: workflow.name }, execution: { id: executionId }, error } }],
  });
}

async function runSub({ workflowId, workspaceId, items, depth }) {
  const wf = await loadWorkflow(workflowId, workspaceId);
  if (!wf) throw new Error(`Workflow ${workflowId} not found`);
  const r = await startAndRun({ workflow: wf, mode: 'subworkflow', triggerItems: items, depth });
  if (r.status === 'error') throw new Error(`Sub-workflow "${wf.name}" failed: ${r.error?.message}`);
  return r;
}

/** Runs a single node in isolation (editor "Test step"). Not recorded as an execution. */
export async function testNodeJob({ workflowId, workspaceId, definition, nodeId, input }) {
  const base = await loadWorkflow(workflowId, workspaceId);
  if (!base) throw new Error('Workflow not found');
  const workflow = definition ? { ...base, definition } : base;
  const r = await runWorkflow({
    workflow, workspaceId, onlyNode: nodeId, onlyInput: input, runSubWorkflow: runSub, staticData: structuredClone(workflow.staticData),
  });
  let result = r.results[nodeId];
  if (result && JSON.stringify(result).length > 900_000) result = { ...result, input: undefined, output: undefined, note: 'data omitted (too large)' };
  return { status: r.status, error: r.error, result };
}

/* ------------------------------- housekeeping --------------------------------- */

/** Deletes expired logs and fails executions whose worker vanished without reporting back. */
export async function pruneExecutions() {
  for (const w of await all('SELECT id FROM workspaces')) {
    const days = (await getPlan(w.id)).logRetentionDays;
    await run('DELETE FROM executions WHERE workspace_id = ? AND started_at < ?', w.id, new Date(Date.now() - days * 86_400_000).toISOString());
  }
  await run(
    "UPDATE executions SET status = 'error', finished_at = ?, error = ? WHERE status IN ('queued','running') AND started_at < ?",
    now(), JSON.stringify({ message: 'Execution was lost (worker stopped or timed out)' }), new Date(Date.now() - 2 * 3_600_000).toISOString(),
  );
}

/** Single-process mode only: anything still queued/running at boot belonged to the previous process. */
export async function failInflightExecutions() {
  await run(
    "UPDATE executions SET status = 'error', finished_at = ?, error = ? WHERE status IN ('queued','running')",
    now(), JSON.stringify({ message: 'Server restarted while this execution was in progress' }),
  );
}
