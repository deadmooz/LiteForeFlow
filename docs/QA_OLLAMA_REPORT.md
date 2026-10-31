# LiteForeFlow - Ollama support QA report

Tested the `ollama-support` branch against a **real Ollama 0.30.10** with model `qwen3.5:4b` (a 4.7B thinking model with tool support) on Windows 11, Node 24. Each case started its own copy of the app with a temporary data folder, so your own data was never touched. Script: `server/test/qa/ollama-qa.mjs` (run `node server/test/qa/ollama-qa.mjs`; Ollama must be running with at least one model).

**Result: 29 pass, 0 fail, 1 not testable** out of 30 cases (full run took about 12 minutes, because a thinking model needs ~20 s per reply). Two cases failed on the first run; both were fixed and re-run (see Defects).

## Defects found

| # | Case | What happened | Severity | Status |
|---|---|---|---|---|
| D1 | OLL-11 | A thinking model with a small *Max tokens* spent every token on its hidden reasoning and the node returned an **empty answer with no error**. Users would see a blank result and not know why. | Medium | **Fixed.** The node now stops with: "The model used all N tokens before it wrote an answer ... Raise Max tokens (try 4000) or pick a model that does not think." Applies to every provider. Unit test added. |
| D2 | OLL-17 | The calculator tool returned `416.50000000000006` for `2450 * 0.17` (floating-point noise), which then leaked into answers. | Low | **Fixed.** Results are rounded to 12 significant digits (`416.5`). |

## Observations (not defects, worth knowing)

- **Speed:** about 20 s per short reply on this PC with a thinking model; a 3000-token budget took ~2 minutes. The five-minute timeout is enough here, but slower computers may need a smaller or non-thinking model.
- **Requests queue:** Ollama answers one request at a time by default, so parallel workflows wait for each other (OLL-22 passed, just slower).
- **Context size:** Ollama reported a 4096-token context for the loaded model. A prompt longer than that is silently cut by Ollama itself. LiteForeFlow cannot see this; long documents need a larger context set on the Ollama side.
- **Default model:** `llama3.2` is not installed on this PC, so a node with an empty Model fails with the friendly "ollama pull llama3.2" message (OLL-03). Users must either pull it or type their model name. Consider showing the installed models in a dropdown later.
- **Memory:** the app stayed under 200 MB after all runs (OLL-23).

## Not covered

- **OLL-29 (model without tool support):** only one model is installed and it supports tools. Run `ollama pull gemma2:2b` and re-run to check the "cannot use tools" message. It is covered by a code path only, not yet by a real model.
- **Browser checks** were done by hand on one screen size (a small window): Provider dropdown lists ollama, credential shows "None" with the "Optional for Ollama" hint, Model placeholder mentions llama3.2, **Test this step** returned `HELLO FROM UI` from `qwen3.5:4b`, and an Ollama credential saved with both optional fields empty. Phone layout was not checked.
- Ollama in Docker or on another machine over the network, HTTPS proxies and API-key proxies were not tried with a real server (the key header is covered by OLL-06 only against local Ollama, which ignores it).

## Test cases and results

| ID | Test case | Steps | Expected | Result | Actual |
|---|---|---|---|---|---|
| OLL-01 | Ollama shows up as a provider and as a credential type | Ask the server for its node types and credential types. | The LLM and AI Agent nodes list "ollama" as a provider; "Ollama (local AI)" is a credential type; the node credential is optional. | **PASS** | provider options and credential type present |
| OLL-02 | LLM answers with no credential at all | LLM node, provider ollama, no credential, prompt "Reply with exactly: PONG". | Run succeeds; output text contains PONG; no credential needed. | **PASS** | "PONG" in 22.5s, model=qwen3.5:4b, tokens=180 |
| OLL-03 | Blank model uses the default (llama3.2) - friendly error if it is not installed | LLM node, provider ollama, Model left empty. | Error says llama3.2 is missing, tells the user to run "ollama pull llama3.2" and lists the installed models. | **PASS** | {"message":"Ollama does not have the model \"llama3.2\". Install it with: ollama pull llama3.2. Installed models: qwen3.5:4b.","nodeId":"l","nodeName":"LLM"} |
| OLL-04 | Saving an Ollama credential with every field empty is accepted, and the secret never comes back | Create credential type ollamaApi with {} then another with a fake API key; read them back. | Both saved (201). The API key is never returned by the API. | **PASS** | both saved, key not in list response |
| OLL-05 | LLM with an explicit credential and address works | LLM node using the "Local" credential (empty) and a second using baseUrl http://localhost:11434. | Both runs succeed. | **PASS** | empty credential and explicit address (with trailing slash) both worked |
| OLL-06 | Sending the API key does not break Ollama and the key is not exposed in run data | Run LLM with the credential that has apiKey sekret-123-xyz, then fetch the execution record. | Run succeeds; the key appears nowhere in the run result or the saved execution. | **PASS** | no leak |
| OLL-07 | System prompt is obeyed | System prompt "Always answer in ALL CAPITAL LETTERS", prompt "say hello to my friend". | Reply is upper case. | **PASS** | HELLO TO YOUR FRIEND! |
| OLL-08 | Expressions in the prompt use data from earlier steps, one answer per item | Edit Fields makes 3 items (names), LLM prompt "Reply with only the first letter of the name {{ $json.name }}". | 3 outputs, in order, each correct. | **PASS** | Z,M,K in 81.0s for 3 items |
| OLL-09 | Parse reply as JSON | LLM node, parseJson on, prompt asks for {"ok": true, "n": 3} only. | Output has a parsed object. If the model adds extra text or breaks JSON, the error is understandable. | **PASS** | parsed {"ok":true,"n":3} |
| OLL-10 | Unicode, emoji and a long prompt are handled | Prompt with Hindi, emoji and ~6000 characters of filler, asking for the word at the very end. | Run succeeds; no crash or garbled request. | **PASS** | answered "BANANA" |
| OLL-11 | Thinking models and a small "Max tokens" budget | LLM node, Max tokens = 40 on a thinking model; then the same prompt with Max tokens = 3000. | Small budget: a clear error that tells the user to raise Max tokens (never a silent empty answer). Large budget: a real answer. | **PASS (first run: FAIL)** | 40 tokens -> clear error; 3000 tokens -> "Sunlight contains all colors of the visible spectrum, but wh" |
| OLL-12 | Model that is not installed | LLM node with Model "no-such-model:1b". | Error tells the user to run "ollama pull no-such-model:1b" and lists the installed models. | **PASS** | {"message":"Ollama does not have the model \"no-such-model:1b\". Install it with: ollama pull no-such-model:1b. Installed models: qwen3.5:4b.","nodeId":"l","nodeName":"LLM"} |
| OLL-13 | Ollama is not running at the address | Credential with address http://127.0.0.1:1. | Error says "Could not reach Ollama at http://127.0.0.1:1. Is it running?" | **PASS** | {"message":"Could not reach Ollama at http://127.0.0.1:1. Is it running? Open the Ollama app (or run \"ollama serve\"), or set the address in the credential.","nodeId":"l","nodeName":"LLM"} |
| OLL-14 | Nonsense address in the credential | Credential address "not a url", and another "ftp://localhost:11434". | A clear error, no crash, the app stays up. | **PASS** | {"message":"Invalid URL: not a url/v1/chat/completions","nodeId":"l","nodeName":"LLM"} \| {"message":"Only http(s) URLs are supported","nodeId":"l","nodeName":"LLM"} |
| OLL-15 | A credential of the wrong type is refused | Ollama provider + an HTTP Bearer credential. | Error names both types. | **PASS** | {"message":"Credential \"Bearer\" is of type httpBearer, expected ollamaApi","nodeId":"l","nodeName":"LLM"} |
| OLL-16 | Regression: OpenAI provider still needs a credential | LLM node, provider openai, no credential. | "No credential selected". | **PASS** | still enforced |
| OLL-17 | AI Agent uses a tool (calculator) with a real model | Agent, provider ollama, tools ["calculator"], "What is 17% of 2450? Use the calculator tool." | steps[0].tool = calculator, output 416.5; final text mentions 416.5. | **PASS (first run: FAIL)** | tool used, answer "17% of 2450 is **416.5**." in 28.9s |
| OLL-18 | AI Agent with no tools just answers | Agent, tools [], prompt "Reply with exactly: DONE". | Success, steps empty, text DONE. | **PASS** | ok |
| OLL-19 | AI Agent can chain two tools (clock then calculator) within max steps | Agent with current_time + calculator, "What year is it now, plus 10? Use tools." | Both tools show in steps; year+10 correct; or a clear "reached max steps" text. | **PASS** | answer 2036 after 2 tool calls |
| OLL-20 | Max tool steps is respected | Agent maxSteps 1 asked to use two tools. | Stops cleanly with "(stopped: reached max steps)" or answers; never loops forever. | **PASS** | (stopped: reached max steps) |
| OLL-21 | Single-node "Test this step" works for Ollama | POST /workflows/:id/nodes/:node/test for an LLM node. | Returns the model output. | **PASS** | ok |
| OLL-22 | Two workflows at the same time | Run 3 LLM workflows in parallel. | All succeed; the app stays responsive. | **PASS** | 3 parallel runs ok, slowest 60.9s |
| OLL-23 | Memory stays small (the app is meant to be lightweight) | Read the app process working set after all the runs above. | Under ~200 MB. | **PASS** | 77 MB |
| OLL-24 | OLLAMA_HOST=127.0.0.1:11434 (no http://) | Start the app with OLLAMA_HOST=127.0.0.1:11434 (no http://); LLM node with no credential. | Works. | **PASS** | worked |
| OLL-25 | OLLAMA_HOST=http://localhost:11434 (full URL) | Start the app with OLLAMA_HOST=http://localhost:11434 (full URL); LLM node with no credential. | Works. | **PASS** | worked |
| OLL-26 | OLLAMA_HOST=0.0.0.0:11434 (how Ollama itself is often set to listen) | Start the app with OLLAMA_HOST=0.0.0.0:11434 (how Ollama itself is often set to listen); LLM node with no credential. | Works. | **PASS** | worked |
| OLL-27 | OLLAMA_HOST pointing at a closed port | Start the app with OLLAMA_HOST pointing at a closed port; LLM node with no credential. | Friendly "Could not reach Ollama" error. | **PASS** | {"message":"Could not reach Ollama at http://127.0.0.1:9. Is it running? Open the Ollama app (or run \"ollama serve\"), or set the address in the cred |
| OLL-28 | BLOCK_PRIVATE_NETWORK=true: Ollama still works, everything else local stays blocked | Start with BLOCK_PRIVATE_NETWORK=true. (a) LLM, no credential. (b) LLM with a credential for another local address. (c) HTTP Request node to localhost:11434. | (a) works, (b) blocked, (c) blocked. | **PASS** | (a) worked, (b) and (c) blocked |
| OLL-29 | Model without tool support | Agent with a model that has no "tools" capability. | Message says the model cannot use tools. | **NOT TESTABLE** | every installed model supports tools (qwen3.5:4b); try "ollama pull gemma2:2b" and re-run |
| OLL-30 | App restarts cleanly and an Ollama workflow still runs | Stop and start the app on the same data folder; run an LLM workflow. | Works after restart; credential still decrypts. | **PASS** | ok |
