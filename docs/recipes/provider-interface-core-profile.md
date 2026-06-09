# Provider Interface — Core Profile

The Core Profile is the minimal subset of the [Provider Interface v2](./provider-interface-v2.md).
It covers token-authenticated project providers that expose tools to a single Copilot session.
Read **only this document** to build a working provider.

---

## Architecture

```
┌─────────────────┐       WebSocket (JSON)       ┌─────────────────┐
│     Gateway      │◄── ws://localhost:9400 ──►   │    Provider      │
│                  │                              │  (your process)  │
│ Owns Copilot SDK │  ── sessions ──────────►     │ Knows nothing    │
│ Runs WS server   │  ◄── auth ─────────────     │ about Copilot    │
│ Registers tools  │  ── hello.ack ─────────►     │ Declares tools   │
│ Dispatches calls │  ◄── hello ────────────     │ Handles calls    │
│                  │  ── tool.call ─────────►     │                  │
│                  │  ◄── tool.result ──────     │                  │
│                  │  ◄── push ─────────────     │ Pushes events    │
│                  │  ◄── tools.update ─────     │ Updates tools    │
└─────────────────┘                              └─────────────────┘
```

---

## Connection state machine

```
 AwaitAuth ──auth──► AwaitHello ──hello──► Bound ──goodbye/disconnect──► Disconnected
     │                    │                  │
     └── error ◄──────────┴── error ◄────────┘
```

| State | Provider may send | Gateway sends |
|---|---|---|
| **AwaitAuth** | `auth` | `sessions` or `error` |
| **AwaitHello** | `hello` | `hello.ack` or `error` |
| **Bound** | `tool.result`, `push`, `tools.update`, `goodbye` | `tool.call`, `tool.cancel`, `session.lifecycle`, `error` |

---

## Authentication

The gateway generates a unique token for the running gateway instance. Providers can discover it from:

- `TAP_PROVIDER_TOKEN` when launched with the Copilot environment.
- `<COPILOT_HOME or ~/.copilot>/extensions/tap/.provider-token` when launched from a sibling terminal or by SDK auto-discovery.

The gateway writes the token file with restrictive permissions and removes it when the gateway stops. Provider sends the token as the first message:

```json
{ "type": "auth", "token": "ptk-a8f3..." }
```

**Success →** gateway sends `sessions`.  **Failure →** `error { code: "AUTH_FAILED" }`, connection closed.

---

## Messages (12 types)

### `auth` — Provider → Gateway

First message. Required fields: `type`, `token`.

### `sessions` — Gateway → Provider

Sent after successful auth. Provider picks one `id` for `hello`.

```json
{ "type": "sessions", "active": [{ "id": "abc123", "label": "PR #42", "cwd": "/code/foo" }] }
```

### `hello` — Provider → Gateway

Register tools, bind to a session.

```json
{
  "type": "hello", "name": "my-provider", "protocolVersion": 2,
  "session": "abc123",
  "tools": [{
    "name": "greet", "description": "Say hello",
    "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
  }]
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Stable provider identity |
| `protocolVersion` | yes | Must be `2` |
| `session` | yes | Session `id` from `sessions.active` |
| `tools` | no | Array of tool defs. Each: `name`, `description`, `parameters` (JSON Schema). Optional `timeout` (ms). |

**Success →** `hello.ack`.  **Failure →** `error` (`INVALID_SESSION`, `UNSUPPORTED_VERSION`, `TOOL_CONFLICT`).

### `hello.ack` — Gateway → Provider

Provider is now **Bound**.

```json
{ "type": "hello.ack", "protocolVersion": 2, "providerId": "p-8f3a", "sessionId": "abc123" }
```

`providerId` is a stable debug ID included in subsequent `error` messages. `sessionId` echoes the session selected by `hello`.

### `tool.call` — Gateway → Provider

```json
{ "type": "tool.call", "id": "call-123", "sessionId": "abc123", "tool": "greet", "args": { "name": "Alice" } }
```

Provider **must** respond with exactly one `tool.result` for this `id`.

### `tool.result` — Provider → Gateway

```json
{ "type": "tool.result", "id": "call-123", "data": "Hello, Alice!" }
```

On failure, use `error` + `errorCode` instead of `data`:

```json
{ "type": "tool.result", "id": "call-123", "error": "Not found", "errorCode": "NOT_FOUND" }
```

Error codes: `NOT_FOUND`, `TIMEOUT`, `CANCELLED`, `INTERNAL`. Exactly one of `data` or `error` should be present.

### `push` — Provider → Gateway

Bound providers can push events to their selected session:

```json
{ "type": "push", "level": "inject", "event": "Page asks for help", "stream": "detour" }
```

| Field | Required | Description |
|---|---|---|
| `level` | yes | `keep`, `surface`, or `inject` |
| `event` | yes | Non-empty event text |
| `stream` | no | EventStream name. Defaults to the provider name in the SDK. |
| `sessionId` | no | Must match the session selected in `hello` when supplied. |
| `metadata` | no | JSON object stored with the stream entry. |

Delivery:

- `keep` stores the event in the stream only.
- `surface` stores and logs the event to the Copilot timeline.
- `inject` stores, logs, and sends the event into the session.

### `tools.update` — Provider → Gateway

Replace this provider's complete tool list while Bound:

```json
{
  "type": "tools.update",
  "tools": [{
    "name": "greet", "description": "Say hello",
    "parameters": { "type": "object", "properties": { "name": { "type": "string" } } }
  }]
}
```

The `tools` field uses the same validation rules as `hello.tools` and remains capped at 100 tools. If `sessionId` is supplied it must match the session selected in `hello`.

Success is silent and triggers the same debounced `registerTools()` + extension reload path used for provider connect/disconnect. On failure, the gateway sends `error` and keeps the previous tool list active. In-flight calls to tools removed by a successful update are not cancelled; they continue to result, timeout, cancellation, or disconnect.

### `tool.cancel` — Gateway → Provider

```json
{ "type": "tool.cancel", "id": "call-123", "sessionId": "abc123", "reason": "timeout" }
```

Provider **must** respond: `{ "type": "tool.result", "id": "call-123", "error": "Cancelled", "errorCode": "CANCELLED" }`.

### `session.lifecycle` — Gateway → Provider

Always sent, no opt-in. Three states:

```json
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "started" }
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "idle" }
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "shutdown.pending", "deadline": 10000 }
```

On `shutdown.pending`: clean up within `deadline` ms, then send `goodbye`. Gateway tears down after the deadline regardless.

### `error` — Gateway → Provider

```json
{ "type": "error", "code": "INVALID_SESSION", "message": "Session def456 does not exist",
  "replyTo": "hello", "providerId": "p-8f3a" }
```

Fields: `code` (required), `message` (required), `replyTo` (optional), `providerId` (optional), `sessionId` (optional).

### `goodbye` — Provider → Gateway

```json
{ "type": "goodbye", "reason": "shutting down" }
```

Send before closing the WebSocket. `reason` is optional.

---

## Protocol rules

### Forward compatibility

- **Ignore unknown fields** in any message.
- **Ignore unknown gateway→provider message types** (log and discard, do not disconnect).
- Gateway **rejects** unknown provider→gateway types with `error { code: "UNKNOWN_TYPE" }`.

### Version negotiation

Provider sends `protocolVersion: 2` in `hello`. Gateway echoes its version in `hello.ack`. Mismatch → `error { code: "UNSUPPORTED_VERSION" }`, connection closed.

### Ordering

Per-connection FIFO. Messages on a single WebSocket arrive in send order.

### Tool call terminal semantics

Each `tool.call` has **one** terminal outcome. First terminal message wins:

1. `tool.result` arrives → complete. Later duplicates silently ignored.
2. `tool.cancel` sent → provider **must** reply `tool.result { errorCode: "CANCELLED" }`. Non-cancelled results arriving after cancel are ignored.
3. Provider disconnects with in-flight calls → gateway returns `errorCode: "DISCONNECTED"` to Copilot. **Not** replayed on reconnect.
4. Malformed JSON, oversized messages, or invalid `tool.result` messages that
   cannot be correlated while calls are in flight fail fast. With one pending
   call, the gateway rejects that call with the protocol/validation error. With
   multiple pending calls, the gateway disconnects the provider and fails all
   pending calls with `DISCONNECTED`.

### Disconnect cleanup

On disconnect (clean or crash): all tools removed, all in-flight calls failed with `DISCONNECTED`. Reconnect = fresh start (re-auth, new `hello`).

### Gateway crash recovery

Gateway is a detached background process. Crash = **all state lost**. Providers detect via `onclose`, reconnect fresh when a new gateway spawns.

### Payload limits

| Limit | Value |
|---|---|
| `tool.result` max size | 5 MB |
| All other messages | 2 MB |
| Max tools per provider | 100 |

Exceeding → `error { code: "PAYLOAD_TOO_LARGE" }`.

If an oversized or malformed bound-provider message arrives while ambiguous
tool calls are pending, the terminal semantics above also apply so in-flight
calls cannot remain pending forever.

---

## Error codes

| Code | Fatal? | Recovery |
|---|---|---|
| `AUTH_FAILED` | **Yes** | Connection closes. Check `TAP_PROVIDER_TOKEN`. |
| `UNSUPPORTED_VERSION` | **Yes** | Connection closes. Update `protocolVersion`. |
| `INVALID_SESSION` | No | Pick a different session from the last `sessions` message. |
| `TOOL_CONFLICT` | No | Rename the tool, re-send `hello`. |
| `PAYLOAD_TOO_LARGE` | No | Reduce payload, retry. |
| `RATE_LIMITED` | No | Back off 1s, retry. |
| `INVALID_JSON` | No | Fix message, retry. |
| `UNKNOWN_TYPE` | No | Check `protocolVersion`. |

---

## Complete example — Node.js

```js
import WebSocket from "ws";

const TOKEN = process.env.TAP_PROVIDER_TOKEN;

function connect() {
  const ws = new WebSocket("ws://localhost:9400");

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case "sessions":
        if (!msg.active.length) { ws.close(); return; }
        ws.send(JSON.stringify({
          type: "hello", name: "example-provider", protocolVersion: 2,
          session: msg.active[0].id,
          tools: [{
            name: "greet", description: "Greet someone by name",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"]
            }
          }]
        }));
        break;

      case "hello.ack":
        console.log(`Registered as ${msg.providerId}`);
        break;

      case "tool.call":
        ws.send(JSON.stringify({
          type: "tool.result", id: msg.id,
          data: `Hello, ${msg.args.name}!`
        }));
        break;

      case "tool.cancel":
        ws.send(JSON.stringify({
          type: "tool.result", id: msg.id,
          error: "Cancelled", errorCode: "CANCELLED"
        }));
        break;

      case "session.lifecycle":
        if (msg.state === "shutdown.pending") {
          ws.send(JSON.stringify({ type: "goodbye", reason: "session ending" }));
          ws.close();
        }
        break;

      case "error":
        console.error(`Error [${msg.code}]: ${msg.message}`);
        if (msg.code === "AUTH_FAILED" || msg.code === "UNSUPPORTED_VERSION") ws.close();
        break;

      default: break; // forward compat: ignore unknown types
    }
  });

  ws.on("close", () => setTimeout(connect, 5000));
}

connect();
```

## Complete example — Python

```python
import asyncio, json, os, websockets

TOKEN = os.environ["TAP_PROVIDER_TOKEN"]

async def connect():
    while True:
        try:
            async with websockets.connect("ws://localhost:9400") as ws:
                await ws.send(json.dumps({"type": "auth", "token": TOKEN}))

                async for raw in ws:
                    msg = json.loads(raw)

                    if msg["type"] == "sessions":
                        if not msg["active"]:
                            return
                        await ws.send(json.dumps({
                            "type": "hello", "name": "example-provider",
                            "protocolVersion": 2, "session": msg["active"][0]["id"],
                            "tools": [{
                                "name": "greet", "description": "Greet someone by name",
                                "parameters": {
                                    "type": "object",
                                    "properties": {"name": {"type": "string"}},
                                    "required": ["name"],
                                },
                            }],
                        }))

                    elif msg["type"] == "hello.ack":
                        print(f"Registered as {msg['providerId']}")

                    elif msg["type"] == "tool.call":
                        await ws.send(json.dumps({
                            "type": "tool.result", "id": msg["id"],
                            "data": f"Hello, {msg['args']['name']}!",
                        }))

                    elif msg["type"] == "tool.cancel":
                        await ws.send(json.dumps({
                            "type": "tool.result", "id": msg["id"],
                            "error": "Cancelled", "errorCode": "CANCELLED",
                        }))

                    elif msg["type"] == "session.lifecycle":
                        if msg["state"] == "shutdown.pending":
                            await ws.send(json.dumps({"type": "goodbye", "reason": "session ending"}))
                            return

                    elif msg["type"] == "error":
                        print(f"Error [{msg['code']}]: {msg['message']}")
                        if msg["code"] in ("AUTH_FAILED", "UNSUPPORTED_VERSION"):
                            return
                    # else: ignore unknown types (forward compat)

        except (ConnectionError, websockets.ConnectionClosed):
            print("Disconnected. Reconnecting in 5s...")
            await asyncio.sleep(5)

asyncio.run(connect())
```

---

## Message summary

| Direction | Type | When | Response expected? |
|---|---|---|---|
| Provider → Gateway | `auth` | First message | `sessions` or `error` |
| Gateway → Provider | `sessions` | After auth | Provider sends `hello` |
| Provider → Gateway | `hello` | After `sessions` | `hello.ack` or `error` |
| Gateway → Provider | `hello.ack` | After `hello` | — |
| Gateway → Provider | `tool.call` | Copilot invokes tool | `tool.result` (**required**) |
| Provider → Gateway | `tool.result` | After `tool.call`/`tool.cancel` | — |
| Gateway → Provider | `tool.cancel` | Timeout/interrupt | `tool.result` with `CANCELLED` (**required**) |
| Provider → Gateway | `push` | Store/surface/inject provider event | — |
| Provider → Gateway | `tools.update` | Replace provider tool list | — |
| Gateway → Provider | `session.lifecycle` | State change | `goodbye` on shutdown (recommended) |
| Gateway → Provider | `error` | Invalid message | — |
| Provider → Gateway | `goodbye` | Before disconnect | — |

---

## Dynamic tool registration

The Copilot SDK does **not** expose a `tools.add` or `tools.update` RPC. Tools are declared once at session creation/resume time and sent to the CLI in that initial handshake. To add or remove provider tools mid-session the Gateway uses two mechanisms together:

### 1. Local handler map — `session.registerTools()`

`CopilotSession.registerTools(tools)` replaces the in-memory handler map (a `Map<name, handler>`). This controls which tool calls the SDK can dispatch locally. The Gateway calls this whenever the combined set of tap + provider tools changes:

```js
// Provider connects — merge its tools into the existing set
session.registerTools([...tapTools, ...providerTools]);

// Provider disconnects — remove its tools
session.registerTools([...tapTools]);
```

This alone is **not sufficient** — the CLI still has the old tool list from the original session handshake.

### 2. Extension reload — `session.rpc.extensions.reload()`

The SDK exposes an experimental RPC:

```js
await session.rpc.extensions.reload();
// Tells the CLI to reload this extension, which re-runs joinSession()
// and picks up the updated tool list
```

This triggers a full re-join: the CLI tears down the current extension session and calls `joinSession()` again, which sends the new `tools` array via the `session.resume` RPC.

### Gateway lifecycle

```
Provider connects
  → Gateway validates auth, receives hello with tool defs
  → Gateway merges provider tools into the session tool set
  → Gateway calls session.registerTools([...tapTools, ...providerTools])
  → Gateway calls session.rpc.extensions.reload()
  → CLI re-joins, sees updated tools, provider tools become available

Provider sends tools.update
  → Gateway validates replacement tool defs
  → Gateway replaces that provider's tools in the merged session tool set
  → Gateway calls session.registerTools([...tapTools, ...providerTools])
  → Gateway calls session.rpc.extensions.reload()
  → CLI re-joins, sees updated tools

Provider disconnects
  → Gateway removes provider tools from the session tool set
  → Gateway calls session.registerTools([...tapTools])
  → Gateway calls session.rpc.extensions.reload()
  → CLI re-joins, provider tools disappear cleanly
```

### Surviving reloads — `globalThis` singleton

`session.rpc.extensions.reload()` re-runs the extension entry point (`extension.mjs`) from scratch. A naïve implementation would lose all runtime state (running emitters, stream history, config). The solution is to cache the runtime on `globalThis` so it persists across reloads:

```js
// extension.mjs — reload-safe pattern
import { joinSession } from "@github/copilot-sdk/extension";
import { createCopilotChannelsRuntime } from "./tap-runtime.mjs";

// First run: creates runtime and caches it.
// Reload: reuses the existing runtime — emitters, streams, config all intact.
const runtime = globalThis.__tapRuntime ??= createCopilotChannelsRuntime({
  cwd: process.cwd()
});

const session = await joinSession({
  tools: runtime.tools,   // includes provider tools if any are connected
  hooks: runtime.hooks
});

runtime.attachSession(session);  // re-wires session port to the new session handle

session.on("session.shutdown", () => {
  void runtime.stopAllEmitters();
});
```

The existing `sessionPort` abstraction already supports session swapping via `attachSession()`, so the new session handle is wired in cleanly without disrupting running emitters or streams.

### Reload frequency — one per provider, not per tool

A provider sends **one `hello` message** containing **all** its tools:

```json
{
  "type": "hello",
  "tools": [tool1, tool2, ..., tool10]
}
```

**1 provider connection = 1 `hello` = 1 reload**, regardless of how many tools it declares.

For multiple providers connecting around the same time, the Gateway should **debounce** the reload call to batch them into a single reload:

```js
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    session.registerTools([...tapTools, ...allProviderTools]);
    session.rpc.extensions.reload();
  }, 200); // batch connections within a 200ms window
}
```

This ensures that even 5 providers connecting simultaneously result in a single reload.

### Caveats

- `session.rpc.extensions.reload()` is marked **`@experimental`** in the SDK (`dist/generated/rpc.js`). Its behavior or availability may change.
- There is no incremental tool update — each reload sends the full tool list. This is fine for the expected scale (≤100 tools per provider, per spec).
- `tools.update` replaces the provider's full tool list. The minimal core profile does not implement request acknowledgments, revision numbers, or per-tool deltas.

---

## What's not in Core

These are in the [full spec](./provider-interface-v2.md), not here:

- External/browser providers and pairing auth
- `"all"` session binding, `session.ready`
- Hooks, gates, transforms
- Stream filters and `stream.query`
- Advanced dynamic updates (`hooks.update`, `context.update`, `filter.set`) and update revisions/acks
- Multi-instance providers, reconnect tokens
- Concurrency limits, tool progress (`tool.progress`)
- Session events (`session.event`, `subscribe`)
