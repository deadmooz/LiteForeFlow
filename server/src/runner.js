import os from 'node:os';
import { all, get, run, uid, now } from './db.js';
import { runWorkflow } from './engine.js';
import { reserveRunAndInsert, reserveRunsAndInsert, refundRun, plans, LimitError } from './plans.js';
import { createBatcher } from './batch.js';
import { onWorkflowChange, isLive } from './changes.js';
import { enqueue } from './queue.js';
import { config } from './config.js';
import { pack } from './packing.js';
import { notifyFailure } from './alerts.js';

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

// A worker runs the same few workflows over and over: keep their parsed form until something changes (changes.js).
// Each run gets its own copy of the static data, which the engine edits in place.
const wfCache = new Map();
const copyStatic = (sd) => (sd && Object.keys(sd).length ? structuredClone(sd) : {});
onWorkflowChange(() => wfCache.clear());
export async function loadWorkflowCached(id, workspaceId) {
  const hit = isLive() ? wfCache.get(id) : null;
  if (hit && hit.wf.workspaceId === workspaceId && hit.exp > Date.now()) return { ...hit.wf, staticData: copyStatic(hit.wf.staticData) };
  const wf = await loadWorkflow(id, workspaceId);
  if (wf && isLive()) {
    if (wfCache.size >= 200) wfCache.clear();
    wfCache.set(id, { wf, exp: Date.now() + 60_000 });
    return { ...wf, staticData: copyStatic(wf.staticData) };
  }
  return wf;
}

/* ------------------------------ execution records ----------------------------- */

const MAX_STORED_ITEMS = 100;
const MAX_STORED_BYTES = 1_000_000;

/** Keeps the execution log bounded so one chatty run cannot bloat the database. */
function compactResults(results) {
  let truncated = false;
  const shrink = (maxItems, maxText, maxList) => {
    // long texts and long lists INSIDE an item are shortened too (an Aggregate block can hold 50,000 objects in one item);
    // only the first entries are walked, so this stays cheap however big the data is
    const cutText = (v) => {
      if (typeof v === 'string') return v.length > maxText ? `${v.slice(0, maxText)}… (${v.length - maxText} more characters)` : v;
      if (Array.isArray(v)) {
        if (v.length <= maxList) return v.map(cutText);
        return [...v.slice(0, maxList).map(cutText), `… ${v.length - maxList} more entries`];
      }
      if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = cutText(v[k]); return o; }
      return v;
    };
    const cut = (outs) => outs?.map((items) => {
      const kept = items.length > maxItems ? items.slice(0, maxItems) : items;
      if (kept !== items) truncated = true;
      return maxText === Infinity ? kept : cutText(kept);
    });
    return Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { ...r, input: cut(r.input), output: cut(r.output) }]));
  };
  // A real API answer (release notes, long descriptions) can be huge. Instead of throwing away every block's data, keep as much as fits:
  // 100 items per block, then fewer items, then shorter texts, and only as a last resort nothing.
  for (const [maxItems, maxText, maxList] of [[MAX_STORED_ITEMS, Infinity, Infinity], [20, 2000, 50], [5, 500, 10], [1, 200, 3]]) {
    const json = JSON.stringify(shrink(maxItems, maxText, maxList));
    if (json.length <= MAX_STORED_BYTES) { if (maxText !== Infinity) truncated = true; return { json, truncated }; }
  }
  truncated = true;
  return { json: JSON.stringify(Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { ...r, input: undefined, output: undefined, note: 'data omitted (too large)' }]))), truncated };
}

const insertBatch = createBatcher(async (items) => {
  const out = new Array(items.length);
  const byWorkspace = new Map();
  items.forEach((it, i) => { if (!byWorkspace.has(it.workspaceId)) byWorkspace.set(it.workspaceId, []); byWorkspace.get(it.workspaceId).push(i); });
  await Promise.all([...byWorkspace].map(async ([workspaceId, idx]) => {
    try {
      await reserveRunsAndInsert(workspaceId, idx.map((i) => items[i]));
    } catch (e) {
      if (!(e instanceof LimitError)) { for (const i of idx) out[i] = e; return; }
      // The cap cannot take all of them: let each run try for itself, so the ones that still fit are accepted.
      for (const i of idx) {
        const it = items[i];
        try {
          await reserveRunAndInsert(workspaceId, 'INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at) SELECT ?,?,?,?,?,?,?',
            [it.id, workspaceId, it.workflowId, it.name, 'queued', it.mode, it.at]);
        } catch (e2) { out[i] = e2; }
      }
    }
  }));
  return out;
}, { maxItems: 100 });

/** The finished state of runs, written many at a time. A run that is no longer queued/running (lost, failed by the queue) is left alone. */
const finishBatch = createBatcher(async (rows) => {
  const col = (k) => rows.map((r) => r[k]);
  await run(
    `UPDATE executions e SET status = v.status, finished_at = v.finished_at, data = v.data, error = v.error, worker = v.worker
     FROM unnest(?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[]) AS v(id, status, finished_at, data, error, worker)
     WHERE e.id = v.id AND e.status IN ('queued','running')`,
    col('id'), col('status'), col('finishedAt'), col('data'), col('error'), col('worker'),
  );
  return [];
}, { maxItems: 50, sizeOf: (r) => (r.data?.length ?? 0) + (r.error?.length ?? 0) + 200 });

/** Counts the run against the plan and inserts a `queued` execution row. Returns its id. */
export async function createExecution({ workflow, mode }) {
  const id = uid();
  if (mode === 'subworkflow' || mode === 'error') {
    await run('INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at) VALUES (?,?,?,?,?,?,?)',
      id, workflow.workspaceId, workflow.id, workflow.name, 'queued', mode, now());
    return id;
  }
  // Counted and recorded together with the other runs arriving at the same moment: one statement, one commit.
  const failure = await insertBatch.add({ id, workspaceId: workflow.workspaceId, workflowId: workflow.id, name: workflow.name, mode, at: now() });
  if (failure instanceof Error) throw failure;
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
  // Most runs finish in a few milliseconds, so writing "running" first would be a wasted commit. Only a run that is still going after
  // a moment is marked (the queue already delivers each job at most once, and the final write skips runs that were closed meanwhile).
  const claimTimer = setTimeout(() => {
    run("UPDATE executions SET status = 'running', worker = ? WHERE id = ? AND status = 'queued'", workerId, executionId).catch(() => {});
  }, 300);
  claimTimer.unref?.();

  const staticBefore = JSON.stringify(workflow.staticData ?? {}); // the engine mutates staticData in place
  let result;
  try {
    result = await runWorkflow({
      workflow, mode, workspaceId: workflow.workspaceId, triggerNodeId, triggerItems,
      staticData: workflow.staticData, depth, runSubWorkflow: runSub,
    });
  } catch (e) {
    result = { status: 'error', error: { message: `Internal error: ${e.message}` }, results: {}, lastOutput: [], staticData: workflow.staticData, finishedAt: now() };
  }

  // High-volume users can drop the per-node data of successful runs (workflow setting, or SAVE_SUCCESS_DATA=false globally).
  // Editor runs always keep it so the canvas can show results.
  const keepData = result.status !== 'success' || mode === 'manual' || (workflow.settings?.saveSuccessData ?? config.saveSuccessData);
  const { json, truncated } = keepData ? compactResults(result.results) : { json: null, truncated: false };
  clearTimeout(claimTimer);
  await finishBatch.add({
    id: executionId, status: result.status, finishedAt: result.finishedAt, data: json && await pack(json),
    error: result.error ? JSON.stringify({ ...result.error, truncated }) : null, worker: workerId,
  });
  // Most workflows never touch static data; only write when it actually changed.
  const staticJson = JSON.stringify(result.staticData ?? {});
  if (staticJson !== staticBefore) {
    await run('UPDATE workflows SET static_data = ? WHERE id = ?', staticJson, workflow.id);
  }

  if (result.status === 'error' && mode !== 'error' && mode !== 'subworkflow') {
    submitErrorWorkflow(workflow, executionId, result.error).catch((e) => console.error('[error-workflow]', e.message));
    // Someone is watching an editor run, so only unattended runs (webhooks, schedules, polling) send an alert.
    if (mode !== 'manual') notifyFailure(workflow, result.error).catch((e) => console.error('[alerts]', e.message));
  }
  // A failed run answers with its error only. Its last output is the data that was fed into the failing step (often the whole
  // request body); callers never read it, and the queue would copy it into Redis for every failure.
  return { executionId, status: result.status, error: result.error, lastOutput: result.status === 'error' ? [] : result.lastOutput, response: result.response };
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
    // The run never started, so it must not eat the customer's monthly quota.
    if (mode !== 'subworkflow' && mode !== 'error' && e.status === 503) await refundRun(workflow.workspaceId).catch(() => {});
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
  // One statement per plan (not one per workspace): a plan's logs all expire after the same number of days.
  const others = Object.keys(plans).filter((k) => k !== 'free');
  for (const [id, plan] of Object.entries(plans)) {
    const cutoff = new Date(Date.now() - plan.logRetentionDays * 86_400_000).toISOString();
    const test = id === 'free' ? `w.plan NOT IN (${others.map(() => '?').join(',')})` : 'w.plan = ?'; // unknown plan names count as free
    await run(`DELETE FROM executions e USING workspaces w WHERE w.id = e.workspace_id AND ${test} AND e.started_at < ?`, ...(id === 'free' ? others : [id]), cutoff);
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
