// A LiteForeFlow plugin. Change anything here, then press Reload on the Plugins page.
// Full guide: docs/PLUGINS.md

export function register(sdk) {
  // A "block" (node). The type must be unique and look like  yourplugin.blockname
  sdk.defineNode({
    type: '__ID_TYPE__.hello',
    name: 'Say Hello',
    group: 'app',            // where it sits in the palette: trigger | core | logic | data | ai | app
    icon: '👋',
    description: 'Adds a greeting to every item. Replace me with something useful.',

    // The settings the user fills in. Types: string, text, number, boolean, options, json, code, keyvalue, conditions.
    properties: [
      { name: 'who', label: 'Who to greet', type: 'string', default: 'world', required: true },
      { name: 'shout', label: 'SHOUT', type: 'boolean', default: false },
    ],

    // Runs once for every item that arrives. Return an object (the new item) or an array of objects.
    // ctx.param('who', i) gives the setting with {{ expressions }} already filled in for item i.
    async executeItem(ctx, item, i) {
      const who = await ctx.param('who', i);
      const text = `Hello, ${who}!`;
      return { ...item.json, greeting: ctx.rawParam('shout') ? text.toUpperCase() : text };
    },
  });
}
