// Adds a few active webhook workflows to a seeded server, so list screens show a mix of states.
//   node server/test/ui/seed-active.mjs <baseUrl> <token>
const [base, token] = process.argv.slice(2);
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const me = (await call('GET', '/api/me')).data;
for (const [i, name] of ['Order received to Slack', 'New lead to CRM', 'Payment failed alert'].entries()) {
  const wf = (await call('POST', '/api/workflows', { name, definition: {
    nodes: [
      { id: 't', type: 'trigger.webhook', name: 'Webhook', parameters: { path: `demo-${i}`, method: 'POST', respond: 'immediately' }, position: { x: 80, y: 160 } },
      { id: 's', type: 'data.set', name: 'Edit Fields', parameters: { fields: [{ name: 'received', value: 'yes' }], keepOthers: true }, position: { x: 360, y: 160 } },
    ],
    connections: [{ from: 't', to: 's', fromOutput: 0, toInput: 0 }],
  } })).data;
  const r = await call('POST', `/api/workflows/${wf.id}/activate`);
  console.log(name, r.status);
}
console.log('workspace', me.currentWorkspaceId);
