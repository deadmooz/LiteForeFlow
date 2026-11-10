/*
 * Write coalescing ("group commit" in the application). Under load, hundreds of tiny writes per second each cost a network
 * round trip and a database commit. A batcher collects the writes that arrive while the previous batch is still being
 * written and sends them as ONE statement.
 *
 * It adds no waiting when the server is quiet: the first write goes out on the next tick (the same tick's writes join it).
 * Only while writes are in flight do newcomers queue up, so the batch size grows with the load on its own.
 *
 *   const batcher = createBatcher(async (values) => results)   // results[i] belongs to values[i] (an Error instance = failed)
 *   const result = await batcher.add(value)                    // resolves when ITS batch is written
 */
export function createBatcher(flushFn, { maxItems = 100, maxBytes = 4_000_000, maxInflight = 2, sizeOf = () => 0 } = {}) {
  let pending = [];
  let bytes = 0;
  let inflight = 0;
  let scheduled = false;

  const pump = () => {
    scheduled = false;
    while (pending.length && inflight < maxInflight) {
      const batch = [];
      let size = 0;
      while (pending.length && batch.length < maxItems && (batch.length === 0 || size + pending[0].size <= maxBytes)) {
        const item = pending.shift();
        size += item.size;
        batch.push(item);
      }
      bytes -= size;
      inflight += 1;
      Promise.resolve().then(() => flushFn(batch.map((b) => b.value))).then(
        (results) => batch.forEach((b, i) => b.resolve(results?.[i])),
        (e) => batch.forEach((b) => b.reject(e)),
      ).finally(() => { inflight -= 1; if (pending.length) pump(); });
    }
  };

  return {
    add(value) {
      return new Promise((resolve, reject) => {
        const size = sizeOf(value);
        pending.push({ value, resolve, reject, size });
        bytes += size;
        if (!scheduled) { scheduled = true; setImmediate(pump); }
      });
    },
    get queued() { return pending.length; },
  };
}
