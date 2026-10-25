/*
 * Declarative node SDK. A node is a plain object:
 *   { type, name, group, icon, description, isTrigger?, inputs?, outputs?, credentialType?,
 *     properties: [{ name, label, type, default, options?, showIf?, required?, placeholder?, help? }],
 *     executeItem(ctx, item, i)  -> object | object[] | null     (runs once per input item)
 *     execute(ctx, inputs)       -> items[][]                    (full control, one array per output)
 *   }
 * Property types: string | text | number | boolean | options | json | code | keyvalue | conditions
 * `showIf: { otherProp: value | [values] }` toggles visibility in the editor.
 * Adding an integration is one object in apps.js.
 */
const registry = new Map();

export function defineNode(def) {
  registry.set(def.type, { inputs: 1, outputs: 1, properties: [], ...def });
}

export const getNodeType = (type) => registry.get(type);

/** JSON-safe description of every node type, for the editor palette. */
export function listNodeTypes() {
  // eslint-disable-next-line no-unused-vars
  return [...registry.values()].map(({ execute, executeItem, ...pub }) => pub);
}

export function withDefaults(def, parameters = {}) {
  const out = { ...parameters };
  for (const p of def.properties) if (out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  return out;
}

export const credentialProperty = (credentialType) => ({
  name: 'credential', label: 'Credential', type: 'credential', credentialType, required: true,
});
