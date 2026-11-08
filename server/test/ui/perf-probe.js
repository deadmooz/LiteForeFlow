// Browser-side probe for the Executions page. Paste it into the console (or run it with the browser tool) while the
// page is open. It flings the list for ~3 s, then types into the search box, and returns one JSON-friendly object:
//   frames (p50/p95/max ms, fps), long main-thread tasks (>50 ms), DOM size, rows rendered vs loaded, JS heap, typing latency.
(async () => {
  const body = document.querySelector('.vbody');
  if (!body) return { error: 'open /executions first (no .vbody found)' };
  const longTasks = [];
  let po = null;
  try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(Math.round(e.duration)))); po.observe({ type: 'longtask' }); } catch { /* not supported */ }

  const frames = [];
  const loadedBefore = body.firstElementChild.style.height;
  await new Promise((resolve) => {
    let last = performance.now();
    const t0 = last;
    const tick = (t) => {
      frames.push(t - last); last = t;
      body.scrollTop += 600; // a hard fling: ~12 rows per frame
      if (t - t0 < 3000) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;

  // typing: set the value like a user would (native setter + input event) and time how long React takes to settle
  const input = document.querySelector('.search input');
  const typed = [];
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    let text = '';
    for (const ch of 'daily report') {
      text += ch;
      const s = performance.now();
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r()));
      typed.push(performance.now() - s);
    }
    await new Promise((r) => setTimeout(r, 400)); // debounce settles
    const shownAfter = document.querySelectorAll('.vrow').length;
    setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }));
    typed.shownAfterFilter = shownAfter;
  }
  po?.disconnect();
  const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  const foot = document.querySelector('.vfoot span')?.textContent ?? '';
  return {
    frames: { count: frames.length, fps: +(1000 / avg).toFixed(1), p50: pct(0.5), p95: pct(0.95), max: +Math.max(...frames).toFixed(1) },
    longTasks: { count: longTasks.length, worstMs: Math.max(0, ...longTasks) },
    dom: { nodes: document.getElementsByTagName('*').length, rowsRendered: document.querySelectorAll('.vrow').length, listHeightBefore: loadedBefore, listHeightAfter: body.firstElementChild.style.height },
    footer: foot,
    heapMB: heap,
    typing: { keystrokes: typed.length, avgMs: +(typed.reduce((a, b) => a + b, 0) / Math.max(1, typed.length)).toFixed(1), maxMs: +Math.max(0, ...typed).toFixed(1), rowsAfterFilter: typed.shownAfterFilter },
  };
})();
