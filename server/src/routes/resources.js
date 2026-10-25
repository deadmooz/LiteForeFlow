import express from 'express';
import crypto from 'node:crypto';
import { all, get, run, uid, now } from '../db.js';
import { HttpError } from './auth.js';
import { encryptJson, decryptJson } from '../crypto.js';
import { credentialTypes, getCredentialType, validateCredentialData } from '../credentialTypes.js';
import { listNodeTypes } from '../nodes/index.js';
import { templates, getTemplate } from '../templates.js';
import { convertN8nWorkflow } from '../importer.js';
import { createWorkflow } from './workflows.js';
import { getUsage, plans, invalidatePlan } from '../plans.js';
import { config } from '../config.js';
import { parseStored } from '../packing.js';
import { httpRequest } from '../http.js';

/* ------------------------------- node types ----------------------------------- */
export const catalogRouter = express.Router();
catalogRouter.get('/node-types', (req, res) => res.json(listNodeTypes()));
catalogRouter.get('/credential-types', (req, res) => res.json(credentialTypes));
catalogRouter.get('/usage', async (req, res) => res.json({ ...(await getUsage(req.workspaceId)), plans: Object.values(plans) }));

/* -------------------------------- credentials --------------------------------- */
export const credentialsRouter = express.Router();
const isSecret = (typeId, field) => getCredentialType(typeId)?.fields.find((f) => f.name === field)?.type === 'password';

credentialsRouter.get('/', async (req, res) => {
  res.json(await all('SELECT id, name, type, created_at AS "createdAt" FROM credentials WHERE workspace_id = ? ORDER BY name', req.workspaceId));
});

/** Never returns secret values — only which secret fields are set. */
credentialsRouter.get('/:id', async (req, res) => {
  const row = await get('SELECT * FROM credentials WHERE id = ? AND workspace_id = ?', req.params.id, req.workspaceId);
  if (!row) throw new HttpError(404, 'Credential not found');
  const data = decryptJson(row.data);
  const visible = Object.fromEntries(Object.entries(data).filter(([k]) => !isSecret(row.type, k)));
  res.json({ id: row.id, name: row.name, type: row.type, data: visible, secretsSet: Object.keys(data).filter((k) => isSecret(row.type, k) && data[k]) });
});

credentialsRouter.post('/', async (req, res) => {
  const { name, type, data } = req.body ?? {};
  if (!name || !type || typeof data !== 'object') throw new HttpError(400, 'name, type and data are required');
  const err = validateCredentialData(type, data);
  if (err) throw new HttpError(400, err);
  const id = uid();
  await run('INSERT INTO credentials (id, workspace_id, name, type, data, created_at) VALUES (?,?,?,?,?,?)', id, req.workspaceId, String(name).slice(0, 80), type, encryptJson(data), now());
  res.status(201).json({ id, name, type });
});

credentialsRouter.put('/:id', async (req, res) => {
  const row = await get('SELECT * FROM credentials WHERE id = ? AND workspace_id = ?', req.params.id, req.workspaceId);
  if (!row) throw new HttpError(404, 'Credential not found');
  const existing = decryptJson(row.data);
  // Blank secret fields mean "keep the stored value".
  const incoming = Object.fromEntries(Object.entries(req.body?.data ?? {}).filter(([k, v]) => !(isSecret(row.type, k) && v === '')));
  const merged = { ...existing, ...incoming };
  const err = validateCredentialData(row.type, merged);
  if (err) throw new HttpError(400, err);
  await run('UPDATE credentials SET name = ?, data = ? WHERE id = ?', req.body?.name ? String(req.body.name).slice(0, 80) : row.name, encryptJson(merged), row.id);
  res.json({ id: row.id, name: req.body?.name ?? row.name, type: row.type });
});

credentialsRouter.delete('/:id', async (req, res) => {
  await run('DELETE FROM credentials WHERE id = ? AND workspace_id = ?', req.params.id, req.workspaceId);
  res.status(204).end();
});

/* ------------------------------- executions ----------------------------------- */
export const executionsRouter = express.Router();

executionsRouter.get('/', async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  const where = ['workspace_id = ?'];
  const args = [req.workspaceId];
  if (req.query.workflowId) { where.push('workflow_id = ?'); args.push(String(req.query.workflowId)); }
  if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
  const rows = await all(
    `SELECT id, workflow_id AS "workflowId", workflow_name AS "workflowName", status, mode, started_at AS "startedAt", finished_at AS "finishedAt", error
     FROM executions WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset,
  );
  res.json(rows.map((r) => ({ ...r, error: r.error ? JSON.parse(r.error) : null })));
});

executionsRouter.get('/:id', async (req, res) => {
  const r = await get('SELECT * FROM executions WHERE id = ? AND workspace_id = ?', req.params.id, req.workspaceId);
  if (!r) throw new HttpError(404, 'Execution not found');
  res.json({
    id: r.id, workflowId: r.workflow_id, workflowName: r.workflow_name, status: r.status, mode: r.mode,
    startedAt: r.started_at, finishedAt: r.finished_at, worker: r.worker, error: r.error ? JSON.parse(r.error) : null,
    results: parseStored(r.data) ?? {},
  });
});

executionsRouter.delete('/:id', async (req, res) => {
  await run('DELETE FROM executions WHERE id = ? AND workspace_id = ?', req.params.id, req.workspaceId);
  res.status(204).end();
});

/* ----------------------- templates, import and billing ------------------------ */
export const toolsRouter = express.Router();

toolsRouter.get('/templates', (req, res) => {
  res.json(templates.map((t) => ({
    id: t.id, name: t.name, description: t.description, category: t.category,
    nodeTypes: [...new Set(t.definition.nodes.map((n) => n.type))],
  })));
});

toolsRouter.post('/templates/:id/use', async (req, res) => {
  const t = getTemplate(req.params.id);
  if (!t) throw new HttpError(404, 'Template not found');
  const def = JSON.parse(JSON.stringify(t.definition));
  for (const n of def.nodes) if (n.type === 'trigger.webhook') n.parameters.path = `${n.parameters.path}-${uid().slice(0, 6)}`;
  res.status(201).json(await createWorkflow(req.workspaceId, t.name, def));
});

toolsRouter.post('/import/n8n', async (req, res) => {
  let converted;
  try { converted = convertN8nWorkflow(req.body?.workflow); } catch (e) { throw new HttpError(400, e.message); }
  const wf = await createWorkflow(req.workspaceId, converted.name, converted.definition);
  res.status(201).json({ workflow: wf, report: converted.report });
});

toolsRouter.post('/billing/checkout', async (req, res) => {
  const plan = req.body?.plan;
  const price = config.stripe.prices[plan];
  if (!config.stripe.secretKey || !price) throw new HttpError(501, 'Billing is not configured on this server (set STRIPE_SECRET_KEY and STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM).');
  const ws = await get('SELECT stripe_customer_id FROM workspaces WHERE id = ?', req.workspaceId);
  const r = await httpRequest({
    method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions', headers: { authorization: `Bearer ${config.stripe.secretKey}` }, bodyType: 'form',
    body: {
      mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': 1,
      success_url: `${config.publicUrl}/settings?billing=success`, cancel_url: `${config.publicUrl}/settings`,
      client_reference_id: req.workspaceId, customer: ws?.stripe_customer_id || undefined, customer_email: ws?.stripe_customer_id ? undefined : req.user.email,
      metadata: { workspaceId: req.workspaceId, plan },
    },
  });
  res.json({ url: r.data.url });
});

/** Dev/demo only: lets you try plan limits without Stripe. Disabled when NODE_ENV=production. */
toolsRouter.post('/billing/dev-plan', async (req, res) => {
  if (config.isProd) throw new HttpError(404, 'Not found');
  if (req.role !== 'owner') throw new HttpError(403, 'Only the owner can change the plan');
  if (!plans[req.body?.plan]) throw new HttpError(400, 'Unknown plan');
  await run('UPDATE workspaces SET plan = ? WHERE id = ?', req.body.plan, req.workspaceId);
  invalidatePlan(req.workspaceId);
  res.json(await getUsage(req.workspaceId));
});

/* Stripe webhook: must be mounted with express.raw() BEFORE the JSON parser. */
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const stripeWebhookRouter = express.Router();
stripeWebhookRouter.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!config.stripe.webhookSecret || !verifyStripeSignature(raw, req.get('stripe-signature'), config.stripe.webhookSecret)) {
    throw new HttpError(400, 'Invalid signature');
  }
  const event = JSON.parse(raw);
  const obj = event.data?.object ?? {};
  if (event.type === 'checkout.session.completed' && obj.metadata?.workspaceId && plans[obj.metadata.plan]) {
    await run('UPDATE workspaces SET plan = ?, stripe_customer_id = ? WHERE id = ?', obj.metadata.plan, obj.customer ?? null, obj.metadata.workspaceId);
    invalidatePlan(obj.metadata.workspaceId);
  } else if (event.type === 'customer.subscription.deleted' && obj.customer) {
    await run("UPDATE workspaces SET plan = 'free' WHERE stripe_customer_id = ?", obj.customer);
  }
  res.json({ received: true });
});
