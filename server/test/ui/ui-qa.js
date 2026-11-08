// Manual-QA scenarios for the Executions UI, run inside the page (console or browser tool). Needs a signed-in session on /executions.
//   await window.__qa.run()   ->  [{ id, name, pass, detail }]
// Every scenario leaves the page usable again, so rounds can be repeated back to back.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const $ = (s) => document.querySelector(s);
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const heap = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN);
  const nodes = () => document.getElementsByTagName('*').length;
  const goto = async (label) => { [...document.querySelectorAll('.sidebar nav a')].find((a) => a.textContent.trim() === label)?.click(); await sleep(250); };
  const waitFor = async (fn, ms = 4000) => { const t = performance.now(); while (performance.now() - t < ms) { if (fn()) return true; await sleep(30); } return false; };
  const out = [];
  const add = (id, name, pass, detail = '') => out.push({ id, name, pass: !!pass, detail });

  async function run() {
    out.length = 0;
    await goto('Executions');
    await waitFor(() => $('.vbody'));

    // UI-0 opening the page cold (arriving from another page) shows the list and not the crash screen
    await goto('Workflows'); await goto('Executions'); await waitFor(() => $('.vbody') || $('.state.bad'));
    add('UI-0', 'opening Executions from another page shows the list, not an error screen', !!$('.vbody') && !$('.state.bad'), $('.state.bad')?.textContent ?? '');

    // UI-1 fast fling: frames stay smooth, DOM stays tiny
    const body = $('.vbody'); const frames = []; let last = performance.now(); const t0 = last;
    await new Promise((res) => { const tick = (t) => { frames.push(t - last); last = t; body.scrollTop += 700; if (t - t0 < 2500) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
    // the first frames after a heavy step include scheduling noise from the browser itself, so they are not counted
    const steady = frames.slice(3).sort((x, y) => x - y); const worst = steady[steady.length - 1]; const p95 = steady[Math.floor(steady.length * 0.95)];
    const rows = document.querySelectorAll('.vrow').length;
    add('UI-1', 'hard fling: p95 frame under 33 ms, none over 100 ms, only the visible rows in the DOM', p95 < 33 && worst < 100 && rows < 40, `p95 ${p95.toFixed(1)} ms, worst ${worst.toFixed(1)} ms, ${rows} rows in DOM`);

    // UI-2 type fast, change filter fast, clear: final list must match the last action (no stale response wins)
    const search = $('.search input'); const select = $('select[aria-label="Filter by status"]');
    for (const v of ['error', 'success', 'error', '', 'success', 'error']) { setValue(select, v); await sleep(15); }
    await sleep(900);
    const statuses = [...document.querySelectorAll('.vrow .badge')].map((b) => b.textContent);
    add('UI-2', 'six filter changes in 100 ms end on the last one (errors only)', statuses.length > 0 && statuses.every((s) => s === 'error'), `${statuses.length} visible, statuses ${[...new Set(statuses)]}`);
    setValue(select, ''); await sleep(700);

    // UI-3 search with no match, then clear: empty state shows and recovers
    setValue(search, 'zzzz-no-such-run'); await sleep(450);
    const empty = !!$('.state');
    setValue(search, ''); await sleep(450);
    add('UI-3', 'a search with no match shows an empty state and recovers when cleared', empty && !!$('.vbody') && !$('.state'), `emptyShown=${empty}`);

    // UI-4 hostile search text does not break the page
    for (const t of ['<img src=x onerror=alert(1)>', '"; DROP TABLE executions; --', 'a'.repeat(5000), '\u0000‮']) { setValue(search, t); await sleep(30); }
    await sleep(450); setValue(search, ''); await sleep(450);
    add('UI-4', 'script, SQL, 5,000-character and control-character search text are handled as plain text', !!$('.vbody') && !document.querySelector('img[src="x"]'), '');

    // UI-5 rapid open / close of the details dialog
    const before = nodes();
    for (let i = 0; i < 25; i += 1) {
      const row = $('.vrow'); if (!row) break; click(row); await frame();
      await waitFor(() => $('.modal'), 1500);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await frame();
    }
    await sleep(300);
    add('UI-5', '25 rapid open/close cycles of the details dialog leave no dialog and no extra DOM', !$('.modal') && nodes() <= before + 5, `nodes ${before} -> ${nodes()}`);

    // UI-6 server error -> error state with a working "Try again"
    const realFetch = window.fetch;
    window.fetch = (u, o) => (String(u).includes('/api/executions') ? Promise.resolve(new Response(JSON.stringify({ error: 'Simulated outage' }), { status: 503, headers: { 'content-type': 'application/json' } })) : realFetch(u, o));
    setValue(select, 'queued'); await sleep(500);
    const errShown = !!$('.state.bad');
    window.fetch = realFetch;
    const retry = [...document.querySelectorAll('.state.bad button')].find((b) => /try again/i.test(b.textContent));
    if (retry) click(retry);
    await sleep(600);
    add('UI-6', 'an API outage shows an error with "Try again", and the list returns when the API does', errShown && !!retry && !$('.state.bad'), `errorShown=${errShown}`);
    setValue(select, ''); await sleep(600);

    // UI-7 garbage in the API answer must not blank the page (boundary) or throw unhandled errors
    let uncaught = 0; const onErr = () => { uncaught += 1; }; window.addEventListener('error', onErr);
    window.fetch = (u, o) => (String(u).includes('/api/executions') ? Promise.resolve(new Response('<html>proxy error</html>', { status: 200, headers: { 'content-type': 'text/html' } })) : realFetch(u, o));
    setValue(select, 'running'); await sleep(500);
    const survived = !!$('.page') && !!$('.sidebar');
    window.fetch = realFetch; window.removeEventListener('error', onErr);
    setValue(select, ''); await sleep(600);
    add('UI-7', 'an HTML (non-JSON) answer from a proxy keeps the app on screen', survived && uncaught === 0, `uncaught=${uncaught}`);

    // UI-8 navigation churn: no growth in DOM or heap
    await goto('Workflows'); await goto('Executions');
    const h0 = heap(); const n0 = nodes();
    for (let i = 0; i < 30; i += 1) { for (const l of ['Workflows', 'Credentials', 'Plugins', 'Templates', 'Executions']) await goto(l); }
    await sleep(500);
    const dh = heap() - h0; const dn = nodes() - n0;
    add('UI-8', '150 page switches do not grow the DOM, and heap growth stays small', Math.abs(dn) < 60 && (Number.isNaN(dh) || dh < 25), `DOM ${n0} -> ${nodes()} (${dn >= 0 ? '+' : ''}${dn}), heap ${Number.isNaN(dh) ? 'n/a' : `${dh >= 0 ? '+' : ''}${dh.toFixed(1)} MB`}`);

    // UI-10 typing must not re-render the list: no DOM change inside the list while the search box fills up (debounced + memoised)
    const listEl = $('.vbody'); let mutations = 0;
    const mo = new MutationObserver((m) => { mutations += m.length; }); mo.observe(listEl, { childList: true, subtree: true, attributes: true, characterData: true });
    let typedText = '';
    for (const ch of 'zzzzzzzz') { typedText += ch; setValue($('.search input'), typedText); await sleep(25); }
    mo.disconnect(); const during = mutations;
    await sleep(500); setValue($('.search input'), ''); await sleep(500);
    add('UI-10', 'typing 8 characters causes no DOM change inside the list while the debounce is pending', during === 0, `mutations during typing: ${during}`);

    // UI-9 keyboard: "/" focuses the search, Enter on a row opens details, Esc closes
    document.activeElement?.blur?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    const focused = document.activeElement === $('.search input');
    $('.search input')?.blur();
    const row = $('.vrow'); row?.focus(); row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => $('.modal'), 1500);
    const opened = !!$('.modal');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await sleep(200);
    add('UI-9', 'keyboard: "/" focuses search, Enter opens a run, Esc closes it', focused && opened && !$('.modal'), `focus=${focused} opened=${opened}`);
    return out;
  }
  window.__qa = { run };
})();
