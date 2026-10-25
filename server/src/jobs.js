import { setJobHandler, setFailedHandler } from './queue.js';
import { get } from './db.js';
import { loadWorkflow, runExecution, failExecution, testNodeJob } from './runner.js';
import { handleCron, handleRssPoll } from './polling.js';

/*
 * Everything a worker can be asked to do. Importing this module registers the handler with the queue,
 * so both the API process (memory queue) and the dedicated worker process get identical behaviour.
 */
async function processJob(payload) {
  switch (payload.kind) {
    case 'execute': {
      const base = await loadWorkflow(payload.workflowId, payload.workspaceId);
      if (!base) {
        await failExecution(payload.executionId, 'Workflow no longer exists');
        return { executionId: payload.executionId, status: 'error', error: { message: 'Workflow no longer exists' }, lastOutput: [] };
      }
      const workflow = payload.definition ? { ...base, definition: payload.definition } : base;
      return runExecution({
        executionId: payload.executionId, workflow, mode: payload.mode,
        triggerNodeId: payload.triggerNodeId, triggerItems: payload.triggerItems, depth: payload.depth,
      });
    }
    case 'test-node': return testNodeJob(payload);
    case 'cron': return handleCron(payload);
    case 'poll-rss': return handleRssPoll(payload);
    default: throw new Error(`Unknown job kind "${payload.kind}"`);
  }
}

/** The queue reports jobs that died (e.g. a worker crashed): make sure the execution row says so. */
async function onJobFailed(jobId, reason) {
  if (!jobId || !(await get('SELECT id FROM executions WHERE id = ?', jobId))) return;
  await failExecution(jobId, `Worker failed: ${reason}`);
}

setJobHandler(processJob);
setFailedHandler(onJobFailed);
