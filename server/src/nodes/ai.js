import { defineNode } from './registry.js';
import { httpRequest } from '../http.js';
import { loadCredential } from '../credentials.js';
import { runCode } from '../expressions.js';
import { config } from '../config.js';

const CRED_BY_PROVIDER = { openai: 'openaiApi', anthropic: 'anthropicApi', ollama: 'ollamaApi' };
const DEFAULT_MODEL = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-5-5', ollama: 'llama3.2' };

const providerProps = [
  {
    name: 'provider', label: 'Provider', type: 'options', default: 'openai', options: ['openai', 'anthropic', 'ollama'],
    help: 'Choose "ollama" to run a model on your own computer for free (install Ollama, then "ollama pull llama3.2"). Choose "openai" with a custom Base URL for any other OpenAI-compatible API (Groq, Together, …).',
  },
  {
    name: 'credential', label: 'Credential', type: 'credential', credentialTypeBy: { param: 'provider', map: CRED_BY_PROVIDER },
    help: 'Optional for Ollama: leave it empty to use Ollama on this computer.',
  },
  {
    name: 'thinking', label: 'Thinking (Ollama models that can think)', type: 'options', default: 'off', showIf: { provider: 'ollama' },
    options: [{ value: 'off', label: 'Off - much faster, right for most automations' }, { value: 'on', label: 'On - slower, for hard problems' }],
    help: 'Some local models (qwen3, deepseek-r1 ...) write a long private reasoning before they answer. Measured: the same small JSON job took 124 s thinking and 4.5 s without.',
  },
  {
    name: 'model', label: 'Model', type: 'string', default: '', placeholder: 'blank = provider default (Ollama: llama3.2)',
    dynamic: true, dynamicIf: { provider: 'ollama' }, help: 'With Ollama this is a list of the models installed on your computer.',
  },
];

/** The editor's model list for Ollama: whatever "ollama list" would show. */
async function loadModels(ctx) {
  if (ctx.param('provider') !== 'ollama') return [];
  const cred = await ctx.credential();
  const origin = (cred.baseUrl || config.ollamaUrl).replace(/\/$/, '');
  let res;
  try {
    res = await httpRequest({ url: `${origin}/api/tags`, headers: cred.apiKey ? { authorization: `Bearer ${cred.apiKey}` } : {}, timeoutMs: 8000, trustedOrigin: config.ollamaUrl });
  } catch (e) {
    if (e.message === 'fetch failed') throw new Error(`Could not reach Ollama at ${origin}. Is it running?`);
    throw e;
  }
  const names = (res.data?.models ?? []).map((m) => m.name);
  if (!names.length) throw new Error('Ollama is running but has no models yet. Run: ollama pull llama3.2');
  return names.map((n) => ({ value: n, label: n }));
}

/** Loads the node's credential; Ollama works without one (it talks to the local server). */
async function loadProviderCredential(ctx, provider) {
  const id = ctx.rawParam('credential');
  if (provider === 'ollama' && !id) return {};
  return loadCredential(ctx.workspaceId, id, CRED_BY_PROVIDER[provider]);
}

/* ---- provider calls ---- */

async function openaiChat(cred, body) {
  const base = (cred.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await httpRequest({
    method: 'POST', url: `${base}/chat/completions`, headers: { authorization: `Bearer ${cred.apiKey}` }, body, timeoutMs: 120000,
  });
  return res.data;
}

/** Ollama speaks the OpenAI chat format under /v1, so it shares the message and tool-call handling with "openai". */
const noThinkRefused = new Set(); // models that answered "I cannot switch thinking off": do not ask again

async function ollamaChat(cred, body) {
  const origin = (cred.baseUrl || config.ollamaUrl).replace(/\/$/, '');
  const model = body.model;
  let res;
  const send = (payload) => httpRequest({
    method: 'POST', url: `${origin}/v1/chat/completions`, body: payload, ignoreStatus: true,
    headers: cred.apiKey ? { authorization: `Bearer ${cred.apiKey}` } : {},
    timeoutMs: 300000, // the first reply can be slow while a big model loads into memory
    trustedOrigin: config.ollamaUrl,
  });
  try {
    const { thinking, ...payload } = body;
    if (thinking === 'off' && !noThinkRefused.has(model)) payload.reasoning_effort = 'none'; // the OpenAI-style way to say "answer directly"
    res = await send(payload);
    if (!res.ok && payload.reasoning_effort && /think|reasoning/i.test(String(res.data?.error?.message ?? res.data?.error ?? ''))) {
      noThinkRefused.add(model);
      delete payload.reasoning_effort;
      res = await send(payload); // an older Ollama or a model without that switch: just ask normally
    }
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`Ollama did not answer within 5 minutes. The model "${model}" may be too big for this computer; try a smaller one.`);
    if (e.message === 'fetch failed') throw new Error(`Could not reach Ollama at ${origin}. Is it running? Open the Ollama app (or run "ollama serve"), or set the address in the credential.`);
    throw e;
  }
  if (res.ok) return res.data;

  const detail = String(res.data?.error?.message ?? res.data?.error ?? res.data ?? '').slice(0, 300);
  if (res.status === 404 && /not found/i.test(detail)) {
    let have = '';
    try {
      const tags = await httpRequest({ url: `${origin}/api/tags`, timeoutMs: 5000, trustedOrigin: config.ollamaUrl });
      const names = (tags.data?.models ?? []).map((m) => m.name);
      have = names.length ? ` Installed models: ${names.join(', ')}.` : ' No models are installed yet.';
    } catch { /* the hint is a bonus */ }
    throw new Error(`Ollama does not have the model "${model}". Install it with:  ollama pull ${model}.${have}`);
  }
  if (/does not support tools/i.test(detail)) {
    throw new Error(`The Ollama model "${model}" cannot use tools. Pick a tool-capable one (for example llama3.2 or qwen2.5), or set Tools to [].`);
  }
  throw new Error(`Ollama error (HTTP ${res.status}): ${detail || 'no details'}`);
}

const chatFor = (provider) => (provider === 'ollama' ? ollamaChat : openaiChat);

async function anthropicMessages(cred, body) {
  const base = (cred.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const res = await httpRequest({
    method: 'POST', url: `${base}/v1/messages`,
    headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' }, body, timeoutMs: 120000,
  });
  return res.data;
}

async function complete({ provider, cred, model, system, prompt, temperature, maxTokens, thinking }) {
  model = model || DEFAULT_MODEL[provider];
  if (provider === 'anthropic') {
    const d = await anthropicMessages(cred, {
      model, max_tokens: maxTokens, temperature, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }],
    });
    return { text: (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model: d.model, usage: d.usage };
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  const d = await chatFor(provider)(cred, { model, messages, temperature, max_tokens: maxTokens, ...(provider === 'ollama' ? { thinking } : {}) });
  const choice = d.choices?.[0];
  const text = choice?.message?.content ?? '';
  // "Thinking" models (for example qwen3, deepseek-r1) count their private reasoning against Max tokens; a small budget leaves no room for the answer.
  if (!text.trim() && choice?.finish_reason === 'length') {
    throw new Error(`The model used all ${maxTokens} tokens before it wrote an answer (thinking models spend many tokens reasoning first). Raise "Max tokens" (try 4000) or pick a model that does not think.`);
  }
  return { text, model: d.model, usage: d.usage };
}

defineNode({
  type: 'ai.llm', name: 'LLM', group: 'ai', icon: '🧠', credentialType: 'openaiApi',
  description: 'Send a prompt to an LLM: OpenAI, Anthropic, Ollama (free, on your own computer) or any OpenAI-compatible API.',
  properties: [
    ...providerProps,
    { name: 'system', label: 'System prompt', type: 'text', default: '' },
    { name: 'prompt', label: 'Prompt', type: 'text', default: 'Summarize: {{ $json.text }}', required: true },
    { name: 'temperature', label: 'Temperature', type: 'number', default: 0.2 },
    { name: 'maxTokens', label: 'Max tokens', type: 'number', default: '', placeholder: 'blank = automatic', help: 'Blank = automatic: 1,024, or 4,000 with Ollama because many local models think for a while before they answer.' },
    { name: 'parseJson', label: 'Parse reply as JSON', type: 'boolean', default: false, help: 'Adds the parsed object under `parsed`.' },
  ],
  loadOptions: loadModels,
  async executeItem(ctx, item, i) {
    const provider = ctx.rawParam('provider');
    const cred = await loadProviderCredential(ctx, provider);
    const out = await complete({
      provider, cred, model: (await ctx.param('model', i)), system: (await ctx.param('system', i)), prompt: (await ctx.param('prompt', i)),
      temperature: Number((await ctx.param('temperature', i))), maxTokens: Number((await ctx.param('maxTokens', i))) || (provider === 'ollama' ? 4000 : 1024), thinking: ctx.rawParam('thinking'),
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
      const result = (await runCode(`return (${expression.replace(/\^/g, '**')});`, {}, { timeoutMs: 500 })).result;
      return String(typeof result === 'number' && Number.isFinite(result) ? Number(result.toPrecision(12)) : result); // 2450*0.17 -> 416.5, not 416.50000000000006
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

async function runAgent({ provider, cred, model, system, prompt, tools, maxSteps, temperature, thinking }) {
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
    const d = await chatFor(provider)(cred, { model, messages, temperature, ...(toolDefs.length ? { tools: toolDefs } : {}), ...(provider === 'ollama' ? { thinking } : {}) });
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
  loadOptions: loadModels,
  async executeItem(ctx, item, i) {
    const provider = ctx.rawParam('provider');
    const cred = await loadProviderCredential(ctx, provider);
    const tools =(await ctx.jsonParam('tools', i)) ?? [];
    if (!Array.isArray(tools)) throw new Error('Tools must be a JSON array of tool names');
    return runAgent({
      provider, cred, model: (await ctx.param('model', i)), system: (await ctx.param('system', i)), prompt: (await ctx.param('prompt', i)),
      tools, maxSteps: Math.min(10, Math.max(1, Number(ctx.rawParam('maxSteps')) || 5)), temperature: Number((await ctx.param('temperature', i))), thinking: ctx.rawParam('thinking'),
    });
  },
});
