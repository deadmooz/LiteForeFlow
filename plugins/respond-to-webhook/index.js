export function register(sdk) {
  sdk.defineNode({
    type: 'respond.webhook', name: 'Respond to Webhook', group: 'core', icon: '📬',
    description: 'Send your own answer back to whoever called the workflow\'s Webhook. Set the Webhook to Respond = "responseNode" first.',
    properties: [
      { name: 'status', label: 'Status code', type: 'number', default: 200, help: '200 = OK, 201 = created, 400 = bad request, 404 = not found.' },
      {
        name: 'send', label: 'Send', type: 'options', default: 'firstItem',
        options: [
          { value: 'firstItem', label: 'The data from the previous step (first item)' },
          { value: 'allItems', label: 'All items from the previous step (a list)' },
          { value: 'json', label: 'JSON I write myself' },
          { value: 'text', label: 'Plain text I write myself' },
          { value: 'empty', label: 'Nothing (just the status code)' },
        ],
      },
      { name: 'json', label: 'JSON answer', type: 'json', default: '{\n  "ok": true\n}', showIf: { send: 'json' }, help: 'You can use {{ $json.field }} inside.' },
      { name: 'text', label: 'Text answer', type: 'text', default: 'OK', showIf: { send: 'text' } },
      { name: 'headers', label: 'Extra headers (optional)', type: 'keyvalue', default: [], help: 'For example Content-Type = text/html, or Location = https://… with status 302.' },
    ],
    async execute(ctx, inputs) {
      const send = ctx.rawParam('send');
      let body;
      if (send === 'firstItem') body = inputs[0][0]?.json ?? {};
      else if (send === 'allItems') body = inputs[0].map((i) => i.json);
      else if (send === 'json') body = await ctx.jsonParam('json', 0);
      else if (send === 'text') body = await ctx.param('text', 0);
      const rows = (await ctx.param('headers', 0)) ?? []; // {{ expressions }} in the values are already filled in
      const headers = {};
      for (const r of Array.isArray(rows) ? rows : []) if (r?.name) headers[r.name] = r.value;
      ctx.setResponse({ status: Number(await ctx.param('status', 0)) || 200, headers, body }); // the status may be an {{ expression }}
      return [inputs[0]];
    },
  });
}
