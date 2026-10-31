import express from 'express';
import crypto from 'node:crypto';
import { get } from '../db.js';
import { getNodeType, withDefaults } from '../nodes/index.js';
import { parseWorkflow, submitExecution } from '../runner.js';

export const webhookRouter = express.Router();

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-webhook-secret']);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const BLOCKED_RESPONSE_HEADERS = new Set(['set-cookie', 'content-length', 'transfer-encoding', 'connection', 'content-security-policy']);

/** Sends what a Respond to Webhook node asked for: { status, headers, body }. Objects go out as JSON, text as it is. */
function sendCustomResponse(res, r) {
  const status = Number.isInteger(Number(r.status)) && Number(r.status) >= 200 && Number(r.status) <= 599 ? Number(r.status) : 200;
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    const value = String(v);
    // line breaks, control characters or a huge value would make Node refuse the whole answer: such a header is simply left out
    if (BLOCKED_RESPONSE_HEADERS.has(String(k).toLowerCase()) || !/^[\w-]+$/.test(k) || /[\u0000-\u001f\u007f]/.test(value) || value.length > 8000) continue;
    try { res.set(k, value); } catch { /* not a valid header: skip it */ }
  }
  res.status(status);
  if (r.body === undefined || r.body === null || r.body === '') return res.end();
  if (typeof r.body === 'object') return res.json(r.body);
  if (!res.get('content-type')) res.type('text/plain');
  return res.send(String(r.body));
}

webhookRouter.all('/*', async (req, res) => {
  const path = req.params[0].replace(/^\/+|\/+$/g, '');
  const row = (await get('SELECT * FROM webhooks WHERE path = ? AND method = ?', path, req.method))
    ?? (await get("SELECT * FROM webhooks WHERE path = ? AND method = 'ANY'", path));
  const wf = row && parseWorkflow(await get('SELECT * FROM workflows WHERE id = ?', row.workflow_id));
  if (!wf?.active) return res.status(404).json({ error: 'Webhook not found or workflow is not active' });

  const node = wf.definition.nodes.find((n) => n.id === row.node_id);
  const params = withDefaults(getNodeType('trigger.webhook'), node?.parameters);
  if (params.secret && !safeEqual(req.get('x-webhook-secret') ?? '', params.secret)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !SENSITIVE_HEADERS.has(k)));
  const items = [{ json: { headers, query: req.query, body: req.body ?? {}, method: req.method, path } }];
  const wait = params.respond === 'lastNode' || params.respond === 'responseNode';

  // The request is only acknowledged once the job is safely queued, so accepted events are never lost.
  const r = await submitExecution({ workflow: wf, mode: 'webhook', triggerNodeId: node.id, triggerItems: items }, { wait });

  if (!wait) return res.json({ message: 'Workflow was started', executionId: r.executionId });
  // A Respond to Webhook node that already ran has made its promise to the caller, even if a later step failed (the run still records the failure).
  if (params.respond === 'responseNode' && r.response) return sendCustomResponse(res, r.response);
  if (r.status === 'error') return res.status(500).json({ error: r.error?.message ?? 'Workflow failed', executionId: r.executionId });
  const out = (r.lastOutput ?? []).map((i) => i.json);
  return res.json(out.length === 1 ? out[0] : out);
});
