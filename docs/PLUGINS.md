# Plugins

A plugin adds **blocks** (nodes) and **credential types** to LiteForeFlow without touching its source code.
The **Plugins** page in the app lists them, shows what each one adds, and (for the owner) turns them on and off.

| Where | What |
|---|---|
| `plugins/<name>/` | Comes with LiteForeFlow ("bundled") |
| `data/plugins/<name>/` | **Yours.** Drop a folder here, then press **Reload** on the Plugins page (or restart) |
| `PLUGINS_DIR` | Optional extra folder to scan (set in `.env`) |

Folders whose name starts with `_` or `.` are ignored.

> **Trust.** A plugin runs inside LiteForeFlow with the same rights as LiteForeFlow itself (it can read your data folder and use the network).
> Only install plugins you wrote or trust, the same as any program. A plugin that crashes while loading is switched off and shown with its error;
> the rest of the app keeps working. Only the first account on the server can turn plugins on or off.

## What ships with LiteForeFlow

| Plugin | Adds |
|---|---|
| **Respond to Webhook** (`respond-to-webhook`) | *Respond to Webhook*: answer the caller with your own status code, headers and body. Set the Webhook trigger to **Respond = responseNode** |
| **Data tools** (`data-tools`) | *Filter, Sort, Remove Duplicates, Split into Batches, Date & Time, Crypto* |
| **REST connector** (`rest-connector`) | A block and a credential type for every service described in `services/*.json`: GitHub, Trello, OpenWeather, Hacker News |

Turn any of them off if you do not need them; the editor palette gets shorter.

## Option A - connect a web service with one JSON file (no code)

The **REST connector** turns a small description into a full block: operation list, input fields, credential form with "how to get this" steps,
**Test connection**, and live dropdowns (for example "pick one of your Trello boards").

1. Copy `plugins/rest-connector/services/_example-service.json` to
   `data/plugin-data/rest-connector/services/yourservice.json` (the folder is created the first time the plugin loads).
2. Edit it (see the table below), then press **Reload** on the Plugins page.
3. A new block with the service name appears in the palette.

A mistake in the file never breaks the app: that one file is skipped and the reason is printed in the server window.

```json
{
  "id": "todoist",                      // letters/numbers, becomes the block type rest.todoist
  "name": "Todoist", "icon": "✅", "description": "Shown in the palette",
  "baseUrl": "https://api.example.com/v1",
  "headers": { "accept": "application/json" },          // sent with every call (optional)
  "auth": { "type": "bearer", "label": "API token" },   // none | bearer | header | basic | query
  "setup": ["Step shown on the credential form"],       // optional
  "test": { "path": "/me", "say": "Connected as {name}." },   // makes "Test connection" work
  "operations": [
    {
      "id": "listTasks", "label": "List tasks", "method": "GET", "path": "/tasks",
      "result": "data.items",            // optional: where the list is in the answer (each entry becomes one item)
      "fields": [
        { "name": "status", "label": "Status", "type": "options", "in": "query", "options": ["open", "done"] },
        { "name": "project", "label": "Project", "type": "options", "in": "query",
          "options": { "from": "/projects", "value": "id", "label": "name" } }    // live dropdown filled from the service
      ]
    }
  ]
}
```

**Auth types:** `bearer` (Authorization: Bearer token), `header` (`"header": "X-API-Key"`, optional `"prefix"`), `basic` (user + password),
`query` (`"params": [{ "name": "key" }, { "name": "token" }]`, add `"as": "appid"` to rename, `"secret": false` for non-secret values).
If the web address contains a per-account part, such as `https://{subdomain}.example.com`, add
`"credentialFields": [{ "name": "subdomain", "label": "Subdomain" }]`.

**Field settings:** `name`, `label`, `type` (`string`, `text`, `number`, `boolean`, `json`, `options`), `in` (where it goes: `path`, `query`, `body`, `header`, or
`ui` for a helper that is only used to fill another dropdown), `required`, `default`, `placeholder`, `help`, `as` (the real name used in the request),
`raw` (let a path value keep its `/`). In a path, write `{fieldname}`; in an options `from`, `{otherfield}` uses another field of the same operation
(that is how Trello's list dropdown follows the board dropdown).

## Option B - write a plugin in JavaScript

```text
data/plugins/my-plugin/
  plugin.json     { "id": "my-plugin", "name": "My Plugin", "version": "1.0.0", "description": "...", "apiVersion": 1 }
  index.js        export function register(sdk) { ... }
```

Quickest start: `npm run plugin:new -- my-plugin` creates this folder from a working example, then press **Reload**.

```js
export function register(sdk) {
  sdk.defineNode({
    type: 'myplugin.hello',          // plugin name + dot + block name; must be unique
    name: 'Say Hello', group: 'app', icon: '👋', description: 'Shown in the palette',
    properties: [
      { name: 'who', label: 'Who to greet', type: 'string', default: 'world', required: true },
    ],
    async executeItem(ctx, item, i) {            // runs once per incoming item
      return { ...item.json, greeting: `Hello, ${await ctx.param('who', i)}!` };
    },
  });
}
```

### Blocks

* `executeItem(ctx, item, i)` returns one object (the new item), an array of objects (several items) or `null` (drop the item).
  Or write `execute(ctx, inputs)` for full control: `inputs[0]` is the list of incoming items, return one list per output, for example `[[...items]]`.
  Items look like `{ json: {...} }`.
* `properties`: each has `name`, `label`, `type`, optional `default`, `required`, `placeholder`, `help`, `options`, `showIf: { otherProperty: value }` and
  `advanced: true` (tucked under "Advanced").
  Types: `string`, `text`, `number`, `boolean`, `options`, `json`, `code`, `keyvalue`, `conditions`, `schedule`, `timezone`, `credential`.
  `options` can be plain strings or `{ value, label }`.
* Other block settings: `group` (`trigger`, `core`, `logic`, `data`, `ai`, `app`), `icon`, `outputs` (default 1) and `outputLabels`.
* **Live dropdowns:** give a property `dynamic: true` and add `loadOptions(ctx, propName)` returning `[{ value, label }]`. The editor fills the list
  from the real service and falls back to typing if it cannot.
* **One input per column:** a property of type `fields` plus `loadFields(ctx, propName)` returning `[{ name, label, type, options? }]`
  (types `string`, `number`, `boolean`, `options`, `date`, `tags`). See the Notion block.

`ctx` (inside `executeItem` / `execute`):

| | |
|---|---|
| `await ctx.param(name, i)` | A setting with `{{ expressions }}` filled in for item `i` |
| `ctx.rawParam(name)` | The setting as typed |
| `await ctx.jsonParam(name, i)` | A JSON setting, parsed |
| `await ctx.credential()` | The decrypted credential the user chose |
| `ctx.log(text)` | Adds a line to the run log |
| `ctx.setResponse({ status, headers, body })` | Sets the answer to the webhook that started the run |
| `ctx.signal` | Aborts when the workflow times out |

### Blocks that wait on a web service for every item

If a block calls an API once per item, write it in two steps and several items can be fetched at the same time (up to `ITEM_CONCURRENCY`, default 5), in order:

```js
sdk.defineNode({
  type: 'myplugin.lookup', name: 'Look up', properties: [/* ... */],
  concurrency: 5,
  parallelSafe: (request) => request.method === 'GET',          // only read-only calls overlap
  async prepareItem(ctx, item, i) { return { method: 'GET', url: await ctx.param('url', i) }; },   // one item at a time (may use {{ expressions }})
  async runPrepared(ctx, request) { return (await sdk.httpRequest({ url: request.url })).data; },  // the waiting part
});
```

`ctx.scratch` is an object that lives for one node run: use it to open a credential once instead of once per item.

### The `sdk` object

`sdk.defineNode(def)`, `sdk.defineCredentialType({ id, name, fields, setup?, test? })`, `sdk.credentialProperty(typeId)` (the "pick a credential" setting),
`sdk.httpRequest({ method, url, headers, query, body })`, `sdk.checkConditions(conds, 'all' | 'any', ctx.sandbox)`, `sdk.dataDir()` (a private folder for your files),
`sdk.pluginDir`, `sdk.readJson(relativePath)`, `sdk.listFiles(folder, '.json')`, `sdk.log(...)`.

A credential type's `fields` are `{ name, label, type: 'string' | 'password' | 'text' | 'boolean', required, placeholder }`; `password` fields are stored
encrypted and never sent back to the browser. Give it `setup: ['step', ...]` for the "how to get this" box and `test(data)` (return a message, or
`{ ok: false, message }` / throw) to make **Test connection** work.

### Good to know

* Block types and credential type ids must be new. A plugin cannot replace a built-in block.
* If you turn a plugin off, workflows that use its blocks fail with "comes from the plugin X, which is switched off" instead of a mystery error.
* Plugins load before the server starts accepting requests, so schedules and webhooks that use plugin blocks work right after a restart.
* Sharing a plugin = sharing its folder (zip it). There is no remote store yet.

## Tests

`server/test/plugins.test.mjs` shows how every part is exercised: loading, a broken plugin, turning off, REST specs against a fake server, live dropdowns,
Respond to Webhook and the data tools.
