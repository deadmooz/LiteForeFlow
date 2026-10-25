import express from 'express';
import { all, get, run, uid, now } from '../db.js';
import { HttpError } from './auth.js';
import { loadWorkflow, submitExecution } from '../runner.js';
import { enqueue } from '../queue.js';
import { activateWorkflow, deactivateWorkflow } from '../scheduler.js';
import { validateWorkflow } from '../engine.js';
import { getNodeType, withDefaults } from '../nodes/index.js';
import { parseStored } from '../packing.js';

export const workflowsRouter = express.Router();

const summary = (row) => {
  const def = JSON.parse(row.definition);
  const triggers = def.nodes.filter((n) => getNodeType(n.type)?.isTrigger).map((n) => n.type);
  return { id: row.id, name: row.name, active: !!row.active, nodeCount: def.nodes.length, triggers, updatedAt: row.updated_at, createdAt: row.created_at };
};

const MAX_NODES = 200;
export function checkDefinition(def) {
  if (!def || !Array.isArray(def.nodes) || !Array.isArray(def.connections)) throw new HttpError(400, 'definition must contain nodes[] and connections[]');
  if (def.nodes.length > MAX_NODES) throw new HttpError(400, `A workflow can have at most ${MAX_NODES} nodes`);
  return { nodes: def.nodes, connections: def.connections };
}

export async function createWorkflow(workspaceId, name, definition, settings = {}) {
  const id = uid();
  await run(
    'INSERT INTO workflows (id, workspace_id, name, active, definition, settings, static_data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, workspaceId, String(name || 'Untitled workflow').slice(0, 120), 0, JSON.stringify(definition), JSON.stringify(settings), '{}', now(), now(),
  );
  return loadWorkflow(id, workspaceId);
}

const mustFind = async (req) => {
  const wf = await loadWorkflow(req.params.id, req.workspaceId);
  if (!wf) throw new HttpError(404, 'Workflow not found');
  return wf;
};

workflowsRouter.get('/', async (req, res) => {
  res.json((await all('SELECT * FROM workflows WHERE workspace_id = ? ORDER BY updated_at DESC', req.workspaceId)).map(summary));
});

workflowsRouter.post('/', async (req, res) => {
  const { name, definition, settings } = req.body ?? {};
  const def = definition ? checkDefinition(definition) : { nodes: [], connections: [] };
  res.status(201).json(await createWorkflow(req.workspaceId, name, def, settings));
});

workflowsRouter.get('/:id', async (req, res) => res.json(await mustFind(req)));

workflowsRouter.put('/:id', async (req, res) => {
  const wf = await mustFind(req);
  const { name, definition, settings } = req.body ?? {};
  const def = definition ? checkDefinition(definition) : wf.definition;
  await run(
    'UPDATE workflows SET name = ?, definition = ?, settings = ?, updated_at = ? WHERE id = ?',
    name ? String(name).slice(0, 120) : wf.name, JSON.stringify(def), JSON.stringify(settings ?? wf.settings), now(), wf.id,
  );
  let updated = await loadWorkflow(wf.id, req.workspaceId);
  let warning;
  if (updated.active) {
    try { await activateWorkflow(updated); } catch (e) {
      await deactivateWorkflow(wf.id);
      updated = await loadWorkflow(wf.id, req.workspaceId);
      warning = `Workflow was deactivated: ${e.message}`;
    }
  }
  res.json({ ...updated, warning });
});

workflowsRouter.delete('/:id', async (req, res) => {
  const wf = await mustFind(req);
  await deactivateWorkflow(wf.id);
  await run('DELETE FROM executions WHERE workflow_id = ?', wf.id);
  await run('DELETE FROM workflows WHERE id = ?', wf.id);
  res.status(204).end();
});

workflowsRouter.post('/:id/duplicate', async (req, res) => {
  const wf = await mustFind(req);
  const definition = JSON.parse(JSON.stringify(wf.definition));
  // Webhook paths must be unique across active workflows.
  for (const n of definition.nodes) {
    if (n.type === 'trigger.webhook' && n.parameters?.path) n.parameters.path = `${n.parameters.path}-${uid().slice(0, 6)}`;
  }
  res.status(201).json(await createWorkflow(req.workspaceId, `${wf.name} (copy)`, definition, wf.settings));
});

workflowsRouter.post('/:id/activate', async (req, res) => {
  const wf = await mustFind(req);
  try { await activateWorkflow(wf); } catch (e) { throw e.status ? e : new HttpError(400, e.message); }
  res.json(await loadWorkflow(wf.id, req.workspaceId));
});

workflowsRouter.post('/:id/deactivate', async (req, res) => {
  const wf = await mustFind(req);
  await deactivateWorkflow(wf.id);
  res.json(await loadWorkflow(wf.id, req.workspaceId));
});

/** Builds the trigger payload for editor runs from the trigger node's sample data. */
function sampleItems(node, override) {
  if (override !== undefined) return [{ json: override }];
  if (node?.type === 'trigger.webhook') {
    const raw = withDefaults(getNodeType(node.type), node.parameters).samplePayload;
    let sample = {};
    try { sample = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : (raw ?? {}); } catch { throw new HttpError(400, 'Webhook sample payload is not valid JSON'); }
    return [{ json: { headers: {}, query: {}, body: {}, method: 'POST', ...sample } }];
  }
  return [{ json: {} }];
}

/** Editor runs go through the same queue as production runs, so they behave identically. */
workflowsRouter.post('/:id/run', async (req, res) => {
  const wf = await mustFind(req);
  const { definition, triggerNodeId, payload } = req.body ?? {};
  const def = definition ? checkDefinition(definition) : wf.definition;
  const issues = validateWorkflow(def);
  if (issues.length) throw new HttpError(400, issues[0]);
  const trigger = def.nodes.find((n) => (triggerNodeId ? n.id === triggerNodeId : getNodeType(n.type)?.isTrigger && !n.disabled));

  const result = await submitExecution({
    workflow: wf, mode: 'manual', triggerNodeId: trigger?.id, triggerItems: sampleItems(trigger, payload),
    definition: definition ? def : undefined,
  }, { wait: true });

  const row = await get('SELECT data FROM executions WHERE id = ?', result.executionId);
  res.json({ ...result, results: parseStored(row?.data) ?? {} });
});

workflowsRouter.post('/:id/nodes/:nodeId/test', async (req, res) => {
  const wf = await mustFind(req);
  const { definition, input } = req.body ?? {};
  const def = definition ? checkDefinition(definition) : wf.definition;
  const node = def.nodes.find((n) => n.id === req.params.nodeId);
  if (!node) throw new HttpError(404, 'Node not found');

  let items = Array.isArray(input) ? input.map((j) => ({ json: j })) : null;
  if (!items) {
    const recent = await all('SELECT data FROM executions WHERE workflow_id = ? AND data IS NOT NULL ORDER BY started_at DESC LIMIT 10', wf.id);
    items = recent.map((r) => parseStored(r.data)?.[node.id]?.input?.[0]).find((x) => x?.length) ?? sampleItems(node);
  }
  res.json(await enqueue({
    kind: 'test-node', workflowId: wf.id, workspaceId: wf.workspaceId, definition: definition ? def : undefined, nodeId: node.id, input: items,
  }, { wait: true }));
});
