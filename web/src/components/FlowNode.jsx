import React from 'react';
import { Handle, Position, getSmoothStepPath } from '@xyflow/react';

/* What is drawn on the canvas: one step, the dotted line while a connection is dragged, and the converters between the
 * saved workflow ({ nodes, connections }) and React Flow's nodes and edges. */

export function parseCases(node) {
  let c = node.parameters?.cases ?? '["a"]';
  try { c = typeof c === 'string' ? JSON.parse(c) : c; } catch { c = []; }
  return Array.isArray(c) ? c : [];
}
export const outputCount = (node, def) => (def.dynamicOutputs === 'switch' ? parseCases(node).length + 1 : def.outputs ?? 1);
export const outputLabel = (node, def, i) => {
  if (def.outputLabels) return def.outputLabels[i];
  if (def.dynamicOutputs === 'switch') return parseCases(node)[i] ?? 'fallback';
  return null;
};

export const FlowNode = React.memo(function FlowNode({ data, selected }) {
  const { node, def, status } = data;
  const inputs = def.inputs ?? 1;
  const outs = outputCount(node, def);
  const h = Math.max(inputs, outs) > 1 ? 28 + Math.max(inputs, outs) * 18 : 56;
  return (
    <div className={`ff-node ${selected ? 'selected' : ''} ${status ?? ''} ${node.disabled ? 'disabled' : ''}`} style={{ minHeight: h }}>
      {Array.from({ length: inputs }, (_, i) => (
        <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left} className={data.near === `in-${i}` ? 'near' : undefined} style={{ top: `${((i + 1) * 100) / (inputs + 1)}%` }} />
      ))}
      <div className="ff-node-icon">{def.icon}</div>
      <div className="ff-node-text">
        <div className="ff-node-name">{node.name}</div>
        <div className="ff-node-type">{def.name}</div>
      </div>
      {Array.from({ length: outs }, (_, i) => (
        <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right} className={data.near === `out-${i}` ? 'near' : undefined} style={{ top: `${((i + 1) * 100) / (outs + 1)}%` }}>
          {outputLabel(node, def, i) !== null && <span className="handle-label">{outputLabel(node, def, i)}</span>}
        </Handle>
      ))}
    </div>
  );
});
export const nodeTypes = { ff: FlowNode };

/*
 * The line shown while one is dragged out of a handle: dotted, with a stepped route and a blue dot at each end.
 * When a step is close enough to take it, the line snaps to that step's handle instead of following the pointer,
 * and an x in the middle says "Esc cancels". `suggestion` is written by the editor and read here on every draw.
 */
export const suggestion = { current: null };
export function ConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition }) {
  const t = suggestion.current;
  const ex = t ? t.point.x : toX; const ey = t ? t.point.y : toY;
  const [path, mx, my] = getSmoothStepPath({
    sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: ex, targetY: ey,
    targetPosition: t ? (t.side === 'in' ? Position.Left : Position.Right) : toPosition, borderRadius: 8,
  });
  return (
    <g className="connect-preview">
      <path d={path} fill="none" className="connect-line" />
      <circle cx={fromX} cy={fromY} r={6} className="connect-dot" />
      <circle cx={ex} cy={ey} r={6} className={t ? 'connect-dot' : 'connect-dot loose'} />
      {t && (
        <g transform={`translate(${mx},${my})`} className="connect-x">
          <circle r={9} />
          <text textAnchor="middle" dominantBaseline="central">×</text>
        </g>
      )}
    </g>
  );
}

// initialWidth/Height let the lines of a brand-new step draw at once instead of waiting for the first measurement.
export const toRF = (node, def, status) => ({ id: node.id, type: 'ff', position: node.position ?? { x: 0, y: 0 }, initialWidth: 190, initialHeight: 56, data: { node, def, status } });
export const toEdge = (c) => ({
  id: `${c.from}-${c.fromOutput ?? 0}-${c.to}-${c.toInput ?? 0}`, source: c.from, target: c.to,
  sourceHandle: `out-${c.fromOutput ?? 0}`, targetHandle: `in-${c.toInput ?? 0}`,
});

