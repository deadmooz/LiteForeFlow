// Browser scenarios for the workflow editor: undo and redo, copy and paste, insert on a line, Esc to cancel, alert settings.
// Open a workflow that has at least two connected steps (one of them not a trigger), then run:
//   await window.__eqa.run()   ->  ["EDIT-1 PASS ...", ...]
// Every scenario puts the canvas back how it found it (by undoing what it did), so rounds can be repeated.
// The script waits for the state it expects (up to 3 s) instead of sleeping, so a slow machine does not cause false failures.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const waitFor = async (fn, ms = 3000) => { const t = performance.now(); while (performance.now() - t < ms) { if (fn()) return true; await sleep(15); } return !!fn(); };
  const key = (k, o = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  const paste = (text = '') => { const dt = new DataTransfer(); if (text) dt.setData('text/plain', text); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
  const nodes = () => $$('.react-flow__node').length;
  const edges = () => $$('.react-flow__edge').length;
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const fire = (type, x, y, target = window) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1, view: window }));
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const stepsAre = (n, e) => nodes() === n && (e === undefined || edges() === e);
  let out = [];
  const add = (id, name, pass, detail = '') => out.push(`${id} ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);
  const undoTo = async (n, e) => { for (let i = 0; i < 8 && !stepsAre(n, e); i += 1) { key('z', { ctrlKey: true }); await waitFor(() => stepsAre(n, e), 700); } await sleep(380); /* let the history settle */ };
  const select = async (el) => { const c = center(el); fire('mousedown', c.x, c.y, el); fire('mouseup', c.x, c.y, el); el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: c.x, clientY: c.y })); await waitFor(() => el.classList.contains('selected'), 1000); };
  const msg = () => $('.inline-msg')?.textContent ?? '';

  async function run() {
    out = [];
    await waitFor(() => $('.react-flow__edge-interaction'), 8000); await sleep(400);
    const n0 = nodes(); const e0 = edges();
    const hasWait = !!$$('.palette-item').find((b) => /Wait/.test(b.textContent));

    // EDIT-1 add a step, undo it, redo it
    $$('.palette-item').find((b) => /No Operation/.test(b.textContent)).click();
    const added = await waitFor(() => stepsAre(n0 + 1)); await sleep(400);
    key('z', { ctrlKey: true }); const undone = await waitFor(() => stepsAre(n0));
    key('z', { ctrlKey: true, shiftKey: true }); const redone = await waitFor(() => stepsAre(n0 + 1));
    await undoTo(n0, e0);
    add('EDIT-1', 'adding a step can be undone and redone with the keyboard', added && undone && redone, `${n0} -> ${n0 + 1} -> ${n0} -> ${n0 + 1}`);

    // EDIT-2 typing in a text box keeps Ctrl+Z for the text
    $$('.palette-item').find((b) => /No Operation/.test(b.textContent)).click(); await waitFor(() => stepsAre(n0 + 1)); await sleep(400);
    const title = $('.title-input'); title.focus(); title.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); await sleep(300);
    const kept = stepsAre(n0 + 1); title.blur(); await undoTo(n0, e0);
    add('EDIT-2', 'Ctrl+Z inside the name box does not undo the canvas', kept);

    // EDIT-3 select all, copy, paste, undo; unrelated text does not paste
    key('a', { ctrlKey: true }); await waitFor(() => $('.select-hint'), 1000);
    const hint = msgHint();
    key('c', { ctrlKey: true }); paste();
    const doubled = await waitFor(() => stepsAre(n0 * 2, e0 * 2));
    const names = $$('.ff-node-name').map((n) => n.textContent); const unique = new Set(names).size === names.length;
    paste('just some words'); await sleep(300); const ignored = stepsAre(n0 * 2);
    await undoTo(n0, e0);
    add('EDIT-3', 'copy and paste keeps the lines between steps, gives unique names, and ignores unrelated text', doubled && unique && ignored && new RegExp(`${n0} steps selected`).test(hint), `hint "${hint.slice(0, 30)}"`);

    // EDIT-4 duplicate and cut
    key('a', { ctrlKey: true }); await sleep(250); key('d', { ctrlKey: true });
    const dup = await waitFor(() => stepsAre(n0 * 2)); await sleep(400);
    key('z', { ctrlKey: true }); await waitFor(() => stepsAre(n0));
    key('a', { ctrlKey: true }); await sleep(250); key('x', { ctrlKey: true });
    const cut = await waitFor(() => stepsAre(0)); paste(); const back = await waitFor(() => stepsAre(n0, e0));
    await undoTo(n0, e0);
    add('EDIT-4', 'Ctrl+D duplicates, Ctrl+X removes and the steps paste back', dup && cut && back, `dup=${dup} cut=${cut} back=${back}`);

    // EDIT-5 hover a line, click +, pick a step, undo with the link
    if (hasWait && $('.react-flow__edge-interaction')) {
      $('.react-flow__edge-interaction').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const showed = await waitFor(() => $('.insert-plus')); $('.insert-plus')?.click();
      const opened = await waitFor(() => $('.insert-picker input'));
      const input = $('.insert-picker input');
      if (input) { setVal(input, 'wait'); await sleep(150); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      const inserted = await waitFor(() => stepsAre(n0 + 1, e0 + 1) && /Inserted between/.test(msg()));
      await sleep(400);
      $$('.inline-msg button').find((b) => /Undo/.test(b.textContent))?.click();
      const reverted = await waitFor(() => stepsAre(n0, e0));
      add('EDIT-5', 'hover a line, click +, choose a step: it is inserted, and the Undo link reverts it in one step', showed && opened && inserted && reverted, `plus=${showed} menu=${opened} inserted=${inserted} reverted=${reverted}`);
      await undoTo(n0, e0);
    } else add('EDIT-5', 'needs a Wait step in the palette and one line', false, 'skipped');

    // EDIT-6 drag a loose step near a line: preview, Esc cancels, drop inserts (a trigger cannot be dropped onto a line, so pick another step)
    if (edges()) {
      const first = $$('.react-flow__node').find((n) => n.querySelector('.react-flow__handle.target') && n.querySelector('.react-flow__handle.source')) ?? $$('.react-flow__node')[0];
      await select(first); key('c', { ctrlKey: true }); paste(); await waitFor(() => stepsAre(n0 + 1)); await sleep(300);
      const loose = $$('.react-flow__node').find((n) => n.classList.contains('selected'));
      const line = $$('.react-flow__edge-path')[0].getBoundingClientRect();
      const mid = { x: line.left + line.width / 2, y: line.top + line.height / 2 };
      const dragTo = async (el) => {
        const s = center(el); fire('mousedown', s.x, s.y, el);
        for (let i = 1; i <= 12; i += 1) { fire('mousemove', s.x + ((mid.x - s.x) * i) / 12, s.y + ((mid.y - s.y) * i) / 12); await sleep(25); }
        await waitFor(() => $('.insert-chip'), 1000);
      };
      await dragTo(loose);
      const chip = $('.insert-chip')?.textContent ?? ''; const lit = $$('.react-flow__edge.insert-target').length;
      key('Escape'); await sleep(150);
      const chipAfter = $('.insert-chip')?.textContent ?? '';
      const e1 = edges();
      fire('mouseup', mid.x, mid.y); await sleep(500);
      const stayed = edges() === e1;
      const loose2 = $$('.react-flow__node').find((n) => n.classList.contains('selected')) ?? loose;
      await dragTo(loose2);
      const preview = /Drop to insert between/.test($('.insert-chip')?.textContent ?? '');
      fire('mouseup', mid.x, mid.y);
      const inserted = await waitFor(() => edges() === e1 + 1 && /Inserted between/.test(msg()));
      add('EDIT-6', 'dragging a loose step over a line shows a preview, Esc cancels it, and dropping inserts it', /Drop to insert between/.test(chip) && lit === 1 && chipAfter === '' && stayed && preview && inserted, `chip=${!!chip} lit=${lit} afterEsc="${chipAfter}" stayedLoose=${stayed} preview2=${preview} inserted=${inserted}`);
      await undoTo(n0, e0);
    } else add('EDIT-6', 'needs a line', false, 'skipped');

    // EDIT-7 the alert settings open and close
    $('.react-flow__pane')?.click(); await waitFor(() => $('.alert-settings'), 1500);
    const box = $('.alert-settings');
    let toggled = false;
    if (box) {
      const cb = box.querySelector('input[type=checkbox]');
      cb.click(); const shown = await waitFor(() => box.querySelectorAll('select').length >= 2 && box.querySelector('input:not([type=checkbox])'));
      cb.click(); toggled = shown && await waitFor(() => box.querySelectorAll('select').length === 0);
    }
    add('EDIT-7', 'the "Tell me if this fails" settings show their fields when switched on and hide them when off', toggled);
    return [...out];
  }
  const msgHint = () => $('.select-hint')?.textContent ?? '';
  window.__eqa = { run };
})();
