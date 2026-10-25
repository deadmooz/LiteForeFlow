import { get, run } from './db.js';

/*
 * Pricing hypothesis: flat price per workspace, executions never metered per step/node.
 * The runsPerMonth caps are a fair-use guardrail, not the billing unit. Tune after beta data.
 */
export const plans = {
  free: { id: 'free', name: 'Free', priceUsd: 0, activeWorkflows: 5, runsPerMonth: 1000, logRetentionDays: 3, members: 1 },
  pro: { id: 'pro', name: 'Pro', priceUsd: 12, activeWorkflows: 100, runsPerMonth: 100_000, logRetentionDays: 14, members: 1 },
  team: { id: 'team', name: 'Team', priceUsd: 39, activeWorkflows: 1000, runsPerMonth: 1_000_000, logRetentionDays: 30, members: 10 },
};

export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.status = 402;
  }
}

// Plans change rarely but are read on every run, so keep them briefly in memory (other processes may lag by the TTL).
const PLAN_TTL_MS = 30_000;
const planCache = new Map();
export const invalidatePlan = (workspaceId) => planCache.delete(workspaceId);

export const getPlan = async (workspaceId) => {
  const hit = planCache.get(workspaceId);
  if (hit && hit.exp > Date.now()) return hit.plan;
  const ws = await get('SELECT plan FROM workspaces WHERE id = ?', workspaceId);
  const plan = plans[ws?.plan] ?? plans.free;
  if (planCache.size > 5000) planCache.clear();
  planCache.set(workspaceId, { plan, exp: Date.now() + PLAN_TTL_MS });
  return plan;
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Atomically counts one run, refusing it when the monthly cap is reached.
 * Metered separately from the executions table so log pruning never resets a customer's usage.
 */
export async function reserveRun(workspaceId) {
  const plan = await getPlan(workspaceId);
  // One atomic statement: insert the month's counter or bump it, but only while under the cap.
  const { changes } = await run(
    'INSERT INTO usage (workspace_id, month, runs) VALUES (?, ?, 1) ON CONFLICT (workspace_id, month) DO UPDATE SET runs = usage.runs + 1 WHERE usage.runs < ?',
    workspaceId, currentMonth(), plan.runsPerMonth,
  );
  if (!changes) {
    throw new LimitError(`Monthly run limit reached (${plan.runsPerMonth.toLocaleString()} on the ${plan.name} plan). Upgrade to continue.`);
  }
}

export async function getUsage(workspaceId) {
  const plan = await getPlan(workspaceId);
  const runs = (await get('SELECT runs FROM usage WHERE workspace_id = ? AND month = ?', workspaceId, currentMonth()))?.runs ?? 0;
  const active = (await get('SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ? AND active = 1', workspaceId)).n;
  const members = (await get('SELECT COUNT(*) AS n FROM members WHERE workspace_id = ?', workspaceId)).n;
  return { plan, runsThisMonth: runs, activeWorkflows: active, members };
}

export async function assertCanActivate(workspaceId, alreadyActive) {
  if (alreadyActive) return;
  const u = await getUsage(workspaceId);
  if (u.activeWorkflows >= u.plan.activeWorkflows) {
    throw new LimitError(`The ${u.plan.name} plan allows ${u.plan.activeWorkflows} active workflows. Deactivate one or upgrade.`);
  }
}

export async function assertCanInvite(workspaceId) {
  const u = await getUsage(workspaceId);
  if (u.members >= u.plan.members) {
    throw new LimitError(`The ${u.plan.name} plan allows ${u.plan.members} member(s). Upgrade to invite more.`);
  }
}
