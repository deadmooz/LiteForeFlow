import { run } from './db.js';
import { getNodeType, withDefaults } from './nodes/index.js';
import { httpRequest } from './http.js';
import { loadWorkflow, startAndRun } from './runner.js';
import { LimitError } from './plans.js';

const decode = (s = '') => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const tag = (block, name) => decode(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]);

export function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
  return blocks.map((b) => {
    const link = tag(b, 'link') || b.match(/<link[^>]*href="([^"]+)"/)?.[1] || '';
    return {
      guid: tag(b, 'guid') || tag(b, 'id') || link, title: tag(b, 'title'), link,
      published: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
      summary: tag(b, 'description') || tag(b, 'summary'),
    };
  });
}

/** Fires a scheduled (cron) trigger. */
export async function handleCron({ workflowId, workspaceId, nodeId }) {
  const wf = await loadWorkflow(workflowId, workspaceId);
  const node = wf?.definition.nodes.find((n) => n.id === nodeId);
  if (!wf?.active || !node || node.disabled) return { skipped: 'inactive' };
  try {
    return await startAndRun({
      workflow: wf, mode: 'trigger', triggerNodeId: nodeId, triggerItems: [{ json: { timestamp: new Date().toISOString() } }],
    });
  } catch (e) {
    if (e instanceof LimitError) { console.warn(`[cron] "${wf.name}" skipped: ${e.message}`); return { skipped: 'limit' }; }
    throw e;
  }
}

/** Polls one RSS trigger; starts a run with the entries that appeared since the last poll. */
export async function handleRssPoll({ workflowId, workspaceId, nodeId }) {
  const wf = await loadWorkflow(workflowId, workspaceId);
  const node = wf?.definition.nodes.find((n) => n.id === nodeId);
  if (!wf?.active || !node || node.disabled) return { skipped: 'inactive' };

  const params = withDefaults(getNodeType(node.type), node.parameters);
  const res = await httpRequest({ url: params.url, responseType: 'text', timeoutMs: 20000 });
  const entries = parseFeed(String(res.data));

  const key = `rss:${node.id}`;
  const staticData = wf.staticData ?? {};
  const seen = new Set(staticData[key] ?? []);
  const isFirstPoll = !staticData[key];
  const fresh = entries.filter((e) => e.guid && !seen.has(e.guid));
  staticData[key] = [...new Set([...entries.map((e) => e.guid), ...seen])].slice(0, 500);
  await run('UPDATE workflows SET static_data = ? WHERE id = ?', JSON.stringify(staticData), wf.id);
  if (isFirstPoll || !fresh.length) return { polled: entries.length, fresh: 0 }; // first poll only records the baseline

  try {
    const latest = await loadWorkflow(workflowId, workspaceId);
    await startAndRun({ workflow: latest, mode: 'trigger', triggerNodeId: node.id, triggerItems: fresh.map((e) => ({ json: e })) });
  } catch (e) {
    if (e instanceof LimitError) { console.warn(`[rss] "${wf.name}" skipped: ${e.message}`); return { skipped: 'limit' }; }
    throw e;
  }
  return { polled: entries.length, fresh: fresh.length };
}

