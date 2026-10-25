// Tiny CLI used by manual resilience drills:  node e2e-helper.mjs <start-slow|status|webhook> [...]
const base = process.env.BASE ?? 'http://localhost:3000';
const email = 'drill@example.com';
const password = 'password123';
const call = async (method, url, body, token) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const login = async () => {
  let r = await call('POST', '/api/auth/login', { email, password });
  if (r.status !== 200) r = await call('POST', '/api/auth/signup', { email, password });
  return r.data.token;
};
const [cmd, arg, arg2] = process.argv.slice(2);
const token = await login();

if (cmd === 'start-slow') {
  const path = `drill-${Date.now().toString(36)}`;
  const wf = (await call('POST', '/api/workflows', {
    name: 'drill', definition: {
      nodes: [
        { id: 't', type: 'trigger.webhook', name: 'Hook', parameters: { path, method: 'POST', respond: 'immediately' }, position: { x: 0, y: 0 } },
        { id: 'w', type: 'logic.wait', name: 'Wait', parameters: { seconds: Number(arg ?? 10) }, position: { x: 200, y: 0 } },
        { id: 's', type: 'data.set', name: 'Done', parameters: { fields: [{ name: 'finished', value: 'yes' }], keepOthers: false }, position: { x: 400, y: 0 } },
      ],
      connections: [{ from: 't', to: 'w', fromOutput: 0, toInput: 0 }, { from: 'w', to: 's', fromOutput: 0, toInput: 0 }],
    },
  }, token)).data;
  await call('POST', `/api/workflows/${wf.id}/activate`, undefined, token);
  const r = await (await fetch(`${base}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  console.log(JSON.stringify({ executionId: r.executionId, path }));
} else if (cmd === 'status') {
  const e = (await call('GET', `/api/executions/${arg}`, undefined, token)).data;
  console.log(JSON.stringify({ status: e.status, worker: e.worker, error: e.error?.message, finished: e.results?.s?.status }));
} else if (cmd === 'webhook') {
  const r = await fetch(`${base}/webhook/${arg}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(r.status, JSON.stringify(await r.json()));
}
