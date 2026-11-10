import { useEffect, useMemo, useRef, useState } from 'react';
import { createHistory } from './flow.js';

/**
 * Undo and redo for the editor. The history keeps snapshots of the serialised workflow (see createHistory in flow.js);
 * a snapshot is taken once the canvas has been still for a moment, so a drag is one step, not hundreds.
 *   ready      true once the workflow has loaded (the first snapshot is the loaded state)
 *   serialize  () => the workflow as { nodes, connections } (changes whenever the canvas does)
 *   restore    (snapshot string) => put that state back on the canvas
 * Returns { undo, redo, canUndo, canRedo, refresh } - call refresh() after restoring so the buttons update.
 */
export function useUndoRedo({ ready, nodes, edges, serialize, restore }) {
  const [, bump] = useState(0); // re-render when the history changes (the buttons depend on it)
  const history = useRef(createHistory()).current;
  const serializeRef = useRef(serialize); serializeRef.current = serialize;
  const restoreRef = useRef(restore); restoreRef.current = restore;

  useEffect(() => {
    if (!ready) return undefined;
    if (!history.ready) { history.reset(JSON.stringify(serialize())); bump((n) => n + 1); return undefined; }
    // serialise only once things have been still: a drag changes `nodes` on every frame
    const t = setTimeout(() => { if (history.commit(JSON.stringify(serialize()))) bump((n) => n + 1); }, 350);
    return () => clearTimeout(t);
  }, [ready, nodes, edges, serialize, history]);

  return useMemo(() => ({
    undo() { history.commit(JSON.stringify(serializeRef.current())); const snap = history.undo(); if (snap) restoreRef.current(snap); },
    redo() { const snap = history.redo(); if (snap) restoreRef.current(snap); },
    refresh: () => bump((n) => n + 1),
    get canUndo() { return history.canUndo; },
    get canRedo() { return history.canRedo; },
  }), [history]);
}
