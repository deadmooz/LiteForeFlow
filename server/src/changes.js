import { config } from './config.js';

/*
 * "Something about workflows or webhooks changed" - the signal that keeps small in-memory caches correct.
 *  - Writes made by THIS process call fire() at once (db.js does it after the write commits).
 *  - Writes made by OTHER processes arrive through Postgres LISTEN/NOTIFY: triggers on the workflows and webhooks tables
 *    (migration 6) send 'ff_wf' after every change, so the API and every worker learn about it within a millisecond or two.
 * Caches are used only while the feed is live (isLive()); if the connection drops they are emptied and bypassed until it is back.
 */
const listeners = new Set();
let live = false;

export const onWorkflowChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const isLive = () => live;
export const fire = () => { for (const fn of listeners) fn(); };

/** Opens the LISTEN connection. Resolves once it is listening (or gives up quietly: caches then stay off). Returns a stop function. */
export async function startChangeFeed() {
  const { default: pg } = await import('pg');
  let stopped = false;
  let client = null;
  let retry = null;

  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: config.databaseUrl });
    let gone = false;
    const lost = () => {
      if (gone) return;
      gone = true;
      live = false;
      fire(); // forget everything: we may have missed changes
      if (!stopped) { clearTimeout(retry); retry = setTimeout(connect, 1000); retry.unref?.(); }
    };
    c.on('error', lost);
    c.on('end', lost);
    c.on('notification', () => fire());
    try {
      await c.connect();
      await c.query('LISTEN ff_wf');
      client = c;
      live = true;
      fire();
    } catch { lost(); c.end().catch(() => {}); }
  };

  await connect();
  return () => { stopped = true; live = false; clearTimeout(retry); client?.end().catch(() => {}); };
}
