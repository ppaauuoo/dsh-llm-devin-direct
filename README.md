# @vorkna/dsh-llm-devin-direct

A [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) LLM provider that runs **Devin/Cognition models as a plain model**, not as an agent.

dsh keeps its own agent loop and its own tools. The provider only streams tokens and tool calls.

```
dsh agent loop ──► this adapter ──► GetChatMessage (protobuf/Connect)
      ▲                                   │
      └───── dsh tools execute ◄── tool-call deltas
```

## Why

The `devin` provider (`@quonaro/dsh-plugin-devin`) spawns `devin acp`, so every model call is a complete Devin agent session with **Devin's own fixed toolset**. ACP offers no way to remove those tools — the harness's tools are never invoked, and `devin acp` has no tool flags.

This package skips ACP. It authenticates with the Devin CLI's credential store, then speaks the same model RPC that Devin Desktop uses internally. The harness's tool schemas travel in the request; the model emits tool calls; **dsh executes them**.

## Requirements

- Node 20+ (uses native `fetch`, `AbortSignal.any`)
- A signed-in Devin CLI (`devin auth status`) or Devin Desktop — the provider reads `~/.local/share/devin/credentials.toml`
- A dsh profile

## Install

**1. Add the package to your profile**

```bash
cd <profile>
pnpm add github:ppaauuoo/dsh-llm-devin-direct
# or pin a tag:  pnpm add github:ppaauuoo/dsh-llm-devin-direct#v0.1.3
# or from a local checkout:  pnpm add file:./plugins/dsh-llm-devin-direct
```

**2. Declare it as a bundle** in `<profile>/package.json`

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-plugin",
      "@vorkna/dsh-llm-devin-direct"
    ]
  }
}
```

This step is the one people miss. A dsh plugin is a **bundle**, not just a package:
`package.json` carries `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, and that
shipped patch row is what inserts the provider into the composed tree. A dependency alone
— or a hand-written row in the profile's `cordis.patch.yml` — does nothing, because the
patch layer only overrides/inserts into ids that already exist.

**3. Restart the app.** The loader does not watch `cordis.patch.yml`, and there is no
`dsh` CLI on PATH for a headless reload. `Devin Direct` then appears in **Settings → Models**.

To make it the default instead of picking it per conversation:

```yaml
- id: agent-default-model
  config:
    provider: devin-direct
    model: gpt-6-1-sol-high
```

To override config after it is loaded, target the row id (which equals the package name):

```yaml
- id: devin-direct
  config:
    maxOutputTokens: 64000
```

## Configure

All fields are optional; defaults work once you are signed in.

| Key | Default | Notes |
| --- | --- | --- |
| `apiKey` | `""` | Explicit Windsurf key; empty = read the credential store |
| `credentialsPath` | `""` | Override `~/.local/share/devin/credentials.toml` |
| `host` | `https://server.codeium.com` | API server |
| `clientIde` | `devin-desktop` | Server gates local-only models on this value — do not change casually |
| `clientVersion` | `""` | Empty = read the desktop's `product.json` |
| `models` | 7 entries | `{ id, devinModel, name, efforts }`; `id` is the dsh route, `devinModel` the wire uid, `efforts` maps a level to its uid |
| `maxOutputTokens` | `128000` | |
| `timeoutMs` | `900000` | Per-request ceiling |
| `maxImages` | `8` | Most recent non-offloaded images per request |
| `maxImageBytes` | `5242880` | Per-image cap; larger images degrade to their text placeholder |

## Reasoning effort

The picker's effort selector is wired up, but it does **not** send an effort field — `GetChatMessageRequest` has none, and the server's `ModelInfo.inference_config.reasoning_effort` is not client-settable. Effort is chosen by the **model uid**, so `reasoningEffort` selects a different `devinModel`:

```js
efforts: { low: "gpt-6-1-sol-low", high: "gpt-6-1-sol-high", max: "gpt-6-1-sol-max" }
```

`listModels` / `resolveModel` advertise those levels as dsh's `reasoning` capability, and `stream()` maps `options.reasoningEffort` onto the uid. A level the route does not advertise falls back to `devinModel`, so a stale saved effort can never lose the route.

The shipped ladders were probed against the live endpoint, which refuses an unknown uid with *"This model is no longer available for your account"* — so an accepted uid is a real model, not a silent fallback. They are **not uniform**, and `off` / `minimal` do not exist:

| Route | Levels |
| --- | --- |
| `gpt-6-1-sol`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |
| `swe-2` | `medium`, `high`, `max` |
| `deepseek-v4-1-flash-1017` | `low`, `high`, `max` |

A route with no `efforts` map advertises nothing and dsh hides the selector — which is the honest state for a uid whose other tiers are unverified. Verify a new ladder before adding it:

```bash
node test/effort.mjs                              # offline: capability shape + uid routing
node test/effort-wire.mjs                         # live: every advertised uid answers
node test/effort-wire.mjs swe-2-medium swe-2-max  # live: probe specific uids
```

## Verify

These checks run against the live endpoint — each makes a real call, so you need
signed-in Devin credentials. Install dev deps first; `lib/` is committed as plain
JS, so there is no build step.

```bash
npm install            # peer dep only, for the tests to resolve the package name
node test/roundtrip.mjs   # auth + GetChatMessage + tool-call decode
node test/adapter.mjs     # dsh StreamChunk sequence is well-formed
node test/loop.mjs        # tool call → tool result → answer (the real agent loop)
node test/errors.mjs      # bad key surfaces as a clean error chunk
node test/vision.mjs      # a real PNG reaches the model (user + tool-role images)
node test/effort.mjs      # reasoning capability + effort→uid routing (offline)
node test/effort-wire.mjs # every advertised effort uid is accepted (live)
```

All should end in `RESULT: PASS`. `adapter.mjs` takes a model uid as an
argument, so you can sweep the table:

```bash
for m in gpt-6-1-sol-high claude-opus-5-5-high swe-2-high; do
  node test/adapter.mjs "$m"
done
```

## Known gaps

1. **No token usage.** The endpoint does not return a usage block, so dsh shows no token/cost figures. Billing still happens server-side.
2. **No image caching.** Every turn re-reads and re-encodes each retained image, since the harness passes blocks per request. Offloaded images correctly arrive as placeholder text.
3. **No reasoning replay.** dsh's `ReasoningBlock` carries no signature, but the server needs its opaque `delta_signature` to continue a thinking trace. Thinking is dropped between turns rather than sent unverifiable.

## Caveats

`exa.api_server_pb` is an **undocumented internal endpoint**. It can change with any Desktop/CLI update. Failures surface as a clean `GetChatMessage HTTP 4xx` in the finish chunk, not silent corruption.

Reusing a Windsurf API key against this RPC is what third-party integrations do, but it is not a sanctioned public API — check it against your own agreement before relying on it.

## Layout

| File | Role |
| --- | --- |
| `lib/wire.js` | protobuf varint/tag/field codec + Connect stream framing |
| `lib/protocol.js` | credentials → JWT → `GetChatMessage` encode → stream decode |
| `lib/index.js` | dsh `LlmAdapter`: `listModels` / `resolveModel` / `prepareCall` / `stream` |

Protocol logic is ported from [`pi-devin-local`](https://github.com/mizorewww/pi-devin) (MIT).

## License

MIT
