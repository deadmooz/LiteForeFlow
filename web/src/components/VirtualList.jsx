import React, { useCallback, useEffect, useRef, useState } from 'react';

/*
 * A windowed list with no dependency. Only the rows that are on screen (plus a few above and below) exist in the DOM,
 * so the cost of scrolling does not depend on how many rows were loaded. Fixed row height keeps the maths trivial.
 * Scroll events are coalesced to one update per animation frame, and the end of the list asks for more rows (onEnd).
 */
function VirtualList({ rows, rowHeight, columns, header, renderRow, rowKey, onEnd, height = 520, overscan = 6, footer }) {
  const box = useRef(null);
  const [top, setTop] = useState(0);
  const [viewport, setViewport] = useState(height);
  const frame = useRef(0);
  const asked = useRef(0);

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (box.current) setTop(box.current.scrollTop);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => box.current && setViewport(box.current.clientHeight));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((top + viewport) / rowHeight) + overscan);

  useEffect(() => {
    // Ask for the next page once, when the last rows come into view; asking again needs more rows to have arrived.
    if (onEnd && last >= rows.length - 3 && asked.current !== rows.length) { asked.current = rows.length; onEnd(); }
  }, [last, rows.length, onEnd]);

  const body = Math.min(height, rows.length * rowHeight);
  return (
    <div className="vlist" style={{ '--cols': columns }}>
      {header && <div className="vhead" role="row">{header}</div>}
      <div ref={box} className="vbody" onScroll={onScroll} style={{ height: body }} role="rowgroup">
        <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
          {rows.slice(first, last).map((row, i) => renderRow(row, { top: (first + i) * rowHeight, height: rowHeight }, rowKey(row)))}
        </div>
      </div>
      {footer && <div className="vfoot">{footer}</div>}
    </div>
  );
}

// Typing in a search box re-renders the page on every key; the list only needs to follow when its own inputs change.
export default React.memo(VirtualList);
