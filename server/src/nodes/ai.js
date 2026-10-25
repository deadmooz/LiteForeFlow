import { defineNode } from './registry.js';
import { httpRequest } from '../http.js';
import { loadCredential } from '../credentials.js';
import { runCode } from '../expressions.js';

const CRED_BY_PROVIDER = { openai: 'openaiApi', anthropic: 'anthropicApi' };
const DEFAULT_MODEL = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-5-5' };

const providerProps = [
  { name: 'provider', label: 'Provider', type: 'options', default: 'openai', options: ['openai', 'anthropic'], help: 'Choose "openai" with a custom Base URL for any OpenAI-compatible API (Groq, Together, Ollama, …).' },
  { name: 'credential', label: 'Credential', type: 'credential', credentialTypeBy: { param: 'provider', map: CRED_BY_PROVIDER }, required: true },
  { name: 'model', label: 'Model', type: 'string', default: '', placeholder: 'blank = provider default' },
];

/* ---- provider calls ---- */

async function openaiChat(cred, body) {
  const base = (cred.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await httpRequest({
    method: 'POST', url: `${base}/chat/completions`, headers: { authorization: `Bearer ${cred.apiKey}` }, body, timeoutMs: 120000,
  });
  return res.data;
}

async function anthropicMessages(cred, body) {
  const base = (cred.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const res = await httpRequest({
    method: 'POST', url: `${base}/v1/messages`,
    headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' }, body, timeoutMs: 120000,
  });
  return res.data;
}

async function complete({ provider, cred, model, system, prompt, temperature, maxTokens }) {
  model = model || DEFAULT_MODEL[provider];
  if (provider === 'anthropic') {
    const d = await anthropicMessages(cred, {
      model, max_tokens: maxTokens, temperature, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }],
    });
    return { text: (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model: d.model, usage: d.usage };
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  const d = await openaiChat(cred, { model, messages, temperature, max_tokens: maxTokens });
  return { text: d.choices?.[0]?.message?.content ?? '', model: d.model, usage: d.usage };
}

defineNode({
  type: 'ai.llm', name: 'LLM', group: 'ai', icon: '🧠', credentialType: 'openaiApi',
  description: 'Send a prompt to an LLM (OpenAI, Anthropic, or any OpenAI-compatible API).',
  properties: [
    ...providerProps,
    { name: 'system', label: 'System prompt', type: 'text', default: '' },
    { name: 'prompt', label: 'Prompt', type: 'text', default: 'Summarize: {{ $json.text }}', required: true },
    { name: 'temperature', label: 'Temperature', type: 'number', default: 0.2 },
    { name: 'maxTokens', label: 'Max tokens', type: 'number', default: 1024 },
    { name: 'parseJson', label: 'Parse reply as JSON', type: 'boolean', default: false, help: 'Adds the parsed object under `parsed`.' },
  ],
  async executeItem(ctx, item, i) {
    const provider = ctx.rawParam('provider');
    const cred = await loadCredential(ctx.workspaceId, ctx.rawParam('credential'), CRED_BY_PROVIDER[provider]);
    const out = await complete({
      provider, cred, model: ctx.param('model', i), system: ctx.param('system', i), prompt: ctx.param('prompt', i),
      temperature: Number(ctx.param('temperature', i)), maxTokens: Number(ctx.param('maxTokens', i)) || 1024,
    });
    if (ctx.rawParam('parseJson')) {
      const m = out.text.match(/```(?:json)?\s*([\s\S]*?)```/);
      try { out.parsed = JSON.parse((m ? m[1] : out.text).trim()); } catch { throw new Error('Model reply was not valid JSON'); }
    }
    return out;
  },
});

/* ---- agent ---- */

const TOOLS = {
  http_get: {
    description: 'Fetch a public URL with HTTP GET and return the response body (truncated to 4000 chars).',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => {
      const r = await httpRequest({ url, timeoutMs: 15000, ignoreStatus: true });
      const s = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return `HTTP ${r.status}\n${s.slice(0, 4000)}`;
    },
  },
  calculator: {
    description: 'Evaluate an arithmetic expression, e.g. "(12.5 * 4) / 3".',
    schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    run: async ({ expression }) => {
      if (!/^[\d\s+\-*/().,%^e]+$/i.test(expression)) throw new Error('Only numbers and + - * / % ( ) are allowed');
      return String(runCode(`return (${expression.replace(/\^/g, '**')});`, {}, { timeoutMs: 500 }).result);
    },
  },
  current_time: {
    description: 'Get the current date and time in ISO 8601 (UTC).',
    schema: { type: 'object', properties: {} },
    run: async () => new Date().toISOString(),
  },
};

async function runTool(name, input) {
  const t = TOOLS[name];
  if (!t) return `Error: unknown tool ${name}`;
  try { return await t.run(input ?? {}); } catch (e) { return `Error: ${e.message}`; }
}

async function runAgent({ provider, cred, model, system, prompt, tools, maxSteps, temperature }) {
  model = model || DEFAULT_MODEL[provider];
  const steps = [];
  const active = tools.filter((t) => TOOLS[t]);

  if (provider === 'anthropic') {
    const messages = [{ role: 'user', content: prompt }];
    const toolDefs = active.map((n) => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].schema }));
    for (let s = 0; s < maxSteps; s += 1) {
      const d = await anthropicMessages(cred, {
        model, max_tokens: 2048, temperature, ...(system ? { system } : {}), messages, ...(toolDefs.length ? { tools: toolDefs } : {}),
      });
      const calls = (d.content ?? []).filter((b) => b.type === 'tool_use');
      if (d.stop_reason !== 'tool_use' || !calls.length) {
        return { text: (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''), steps };
      }
      messages.push({ role: 'assistant', content: d.content });
      const results = [];
      for (const c of calls) {
        const output = await runTool(c.name, c.input);
        steps.push({ tool: c.name, input: c.input, output: output.slice(0, 500) });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: output });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: '(stopped: reached max steps)', steps };
  }

  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  const toolDefs = active.map((n) => ({ type: 'function', function: { name: n, description: TOOLS[n].description, parameters: TOOLS[n].schema } }));
  for (let s = 0; s < maxSteps; s += 1) {
    const d = await openaiChat(cred, { model, messages, temperature, ...(toolDefs.length ? { tools: toolDefs } : {}) });
    const msg = d.choices?.[0]?.message ?? {};
    if (!msg.tool_calls?.length) return { text: msg.content ?? '', steps };
    messages.push(msg);
    for (const c of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(c.function.arguments || '{}'); } catch { /* model sent bad JSON */ }
      const output = await runTool(c.function.name, input);
      steps.push({ tool: c.function.name, input, output: output.slice(0, 500) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: output });
    }
  }
  return { text: '(stopped: reached max steps)', steps };
}

defineNode({
  type: 'ai.agent', name: 'AI Agent', group: 'ai', icon: '🤖', credentialType: 'openaiApi',
  description: 'An LLM that can decide to call tools (HTTP GET, calculator, clock) before answering.',
  properties: [
    ...providerProps,
    { name: 'system', label: 'System prompt', type: 'text', default: 'You are a helpful assistant.' },
    { name: 'prompt', label: 'Task / message', type: 'text', default: '{{ $json.body.message }}', required: true },
    { name: 'tools', label: 'Tools (JSON array)', type: 'json', default: '["http_get","calculator","current_time"]', help: 'Any of: http_get, calculator, current_time' },
    { name: 'maxSteps', label: 'Max tool steps', type: 'number', default: 5 },
    { name: 'temperature', label: 'Temperature', type: 'number', default: 0.2 },
  ],
  async executeItem(ctx, item, i) {
    const provider = ctx.rawParam('provider');
    const cred = await loadCredential(ctx.workspaceId, ctx.rawParam('credential'), CRED_BY_PROVIDER[provider]);
    const tools = ctx.jsonParam('tools', i) ?? [];
    if (!Array.isArray(tools)) throw new Error('Tools must be a JSON array of tool names');
    return runAgent({
      provider, cred, model: ctx.param('model', i), system: ctx.param('system', i), prompt: ctx.param('prompt', i),
      tools, maxSteps: Math.min(10, Math.max(1, Number(ctx.rawParam('maxSteps')) || 5)), temperature: Number(ctx.param('temperature', i)),
    });
  },
});
