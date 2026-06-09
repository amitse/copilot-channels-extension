# Extending ※ tap with Providers

External processes can register tools with your Copilot session through the **Provider Interface**. A provider connects via WebSocket, authenticates, declares its tools, and handles calls — without knowing anything about the Copilot SDK.

```
┌─────────────────┐       WebSocket (JSON)       ┌─────────────────┐
│  ※ tap Gateway   │◄── ws://localhost:9400 ──►   │    Provider      │
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

## Quick start

### 1. Start a Copilot session

The gateway starts automatically on loopback port 9400 (`127.0.0.1`, reachable as `localhost`) when ※ tap loads. It generates an auth token and exposes it in two local-only discovery locations:

- `TAP_PROVIDER_TOKEN` for providers launched with the Copilot environment.
- `<COPILOT_HOME or ~/.copilot>/extensions/tap/.provider-token` for sibling terminals and SDK auto-discovery.

The token directory is created with restrictive permissions (`0700`), the token file is written as `0600`, and the token file is removed when the gateway stops.

### 2. Write a provider

A provider is any process that speaks the WebSocket protocol. Here's a minimal example in Node.js:

```js
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function discoverToken() {
  if (process.env.TAP_PROVIDER_TOKEN) return process.env.TAP_PROVIDER_TOKEN;
  const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  return fs.readFileSync(path.join(copilotHome, "extensions", "tap", ".provider-token"), "utf8").trim();
}

const TOKEN = discoverToken();
const ws = new WebSocket("ws://localhost:9400");

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);

  switch (msg.type) {
    case "sessions":
      // Bind to the first available session and register tools
      ws.send(JSON.stringify({
        type: "hello",
        name: "my-provider",
        protocolVersion: 2,
        session: msg.active[0].id,
        tools: [{
          name: "greet",
          description: "Greet someone by name",
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
      // Handle the call and return a result
      ws.send(JSON.stringify({
        type: "tool.result",
        id: msg.id,
        data: `Hello, ${msg.args.name}!`
      }));
      break;

    case "tool.cancel":
      ws.send(JSON.stringify({
        type: "tool.result",
        id: msg.id,
        error: "Cancelled",
        errorCode: "CANCELLED"
      }));
      break;

    case "session.lifecycle":
      if (msg.state === "shutdown.pending") {
        ws.send(JSON.stringify({ type: "goodbye", reason: "session ending" }));
        ws.close();
      }
      break;

    case "error":
      console.error(`[${msg.code}]: ${msg.message}`);
      break;
  }
});
```

### 3. Run it

```bash
# If you are in the terminal where Copilot is running, the token is also in env:
echo $TAP_PROVIDER_TOKEN   # macOS/Linux
echo %TAP_PROVIDER_TOKEN%  # Windows

# In another terminal, either pass the token explicitly:
TAP_PROVIDER_TOKEN=ptk-... node my-provider.mjs

# Or let the SDK/sample discover it from
# <COPILOT_HOME or ~/.copilot>/extensions/tap/.provider-token:
node my-provider.mjs
```

Once connected, the `greet` tool appears in Copilot alongside the existing ※ tap tools. Ask Copilot to use it:

> _"Use the greet tool to say hello to Alice"_

## Connection lifecycle

```
AwaitAuth ──auth──► AwaitHello ──hello──► Bound ──goodbye/disconnect──► Disconnected
```

1. **AwaitAuth** — Provider sends `auth` with the token. Gateway responds with `sessions` (list of active sessions).
2. **AwaitHello** — Provider sends `hello` with its name, protocol version, session choice, and tool definitions. Gateway responds with `hello.ack`.
3. **Bound** — Provider receives `tool.call` messages and responds with `tool.result`. It may also send `push` events or replace its tool list with `tools.update`. Gateway sends `session.lifecycle` events.
4. **Disconnected** — On `goodbye`, WebSocket close, or crash. All tools are removed and in-flight calls fail.

On `session.lifecycle` with `state: "shutdown.pending"`, send `goodbye` promptly. The gateway keeps existing provider sockets open until `goodbye` or the shutdown deadline, then closes any remaining sockets.

## Message reference

| Direction | Type | When |
|---|---|---|
| Provider → Gateway | `auth` | First message — send the token |
| Gateway → Provider | `sessions` | After auth — pick a session |
| Provider → Gateway | `hello` | After sessions — register tools |
| Gateway → Provider | `hello.ack` | Bound — tools are live; includes `providerId` and `sessionId` |
| Gateway → Provider | `tool.call` | Copilot invokes your tool |
| Provider → Gateway | `tool.result` | Your response (exactly one per call) |
| Gateway → Provider | `tool.cancel` | Timeout/interrupt — respond with `CANCELLED` |
| Provider → Gateway | `push` | Store, surface, or inject a provider event |
| Provider → Gateway | `tools.update` | Replace this provider's tool list |
| Gateway → Provider | `session.lifecycle` | Session state changes (`started`, `idle`, `shutdown.pending`) |
| Gateway → Provider | `error` | Something went wrong |
| Provider → Gateway | `goodbye` | Before disconnecting |

## Tool definitions

Each tool in the `hello` message needs:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique tool name (must not conflict with tap tools or other providers) |
| `description` | yes | What the tool does |
| `parameters` | yes | JSON Schema object describing the arguments |
| `timeout` | no | Max execution time in ms |

A provider can register up to **100 tools**.

Bound providers may replace the entire list with:

```json
{ "type": "tools.update", "tools": [ /* same tool definition shape as hello.tools */ ] }
```

The update is session-bound: if `sessionId` is supplied it must match the session selected in `hello`. Success is silent and triggers the same debounced tool refresh as provider connect/disconnect. Rejected updates receive `error` (for example `TOOL_CONFLICT`), and the previously registered tool list stays active. In-flight calls to tools removed by an accepted update continue to their normal result, timeout, cancellation, or disconnect outcome.

## Push events

The provider SDK helpers map to bound-provider `push` messages:

```js
provider.keep("stored in the provider stream only");
provider.surface("visible in the Copilot timeline");
provider.push("inject this into the active session");
```

Wire shape:

```json
{ "type": "push", "level": "inject", "event": "Browser page asks for help", "stream": "detour" }
```

`level` must be `keep`, `surface`, or `inject`. `stream` is optional and defaults to the provider name. Pushes are delivered only to the session chosen in `hello`; an optional `sessionId` must match that bound session. `metadata` may be a JSON object and is stored with the event.

## Error handling

| Code | Fatal? | Meaning |
|---|---|---|
| `AUTH_FAILED` | Yes | Bad token — connection closes |
| `UNSUPPORTED_VERSION` | Yes | Wrong `protocolVersion` — connection closes |
| `INVALID_SESSION` | No | Session ID doesn't exist — pick another |
| `TOOL_CONFLICT` | No | Tool name already taken — rename and retry |
| `PAYLOAD_TOO_LARGE` | No | Message exceeds size limit |

Payload limits: `tool.result` max 5 MB, all other messages max 2 MB.

When a bound provider has in-flight `tool.call` messages, malformed JSON,
oversized messages, or invalid `tool.result` messages that cannot be correlated
are fail-fast: one pending call is rejected with the protocol error; multiple
pending calls cause the provider to disconnect and all in-flight calls to fail
with `DISCONNECTED`.

## Writing providers in other languages

The protocol is plain JSON over WebSocket. Any language with a WebSocket client works. See [the full spec](./docs/recipes/provider-interface-core-profile.md) for a Python example.

## Multiple providers

Multiple providers can connect simultaneously. Each gets its own tool namespace. The gateway debounces tool registration (200ms) so multiple providers connecting at the same time trigger only one reload.

## Dynamic tool registration

When a provider connects or disconnects, ※ tap:

1. Merges all provider tools with the existing tap tools
2. Calls `session.registerTools()` to update the in-memory handler map
3. Calls `session.rpc.extensions.reload()` to make the CLI pick up the new tools

This happens automatically — providers just connect and their tools appear.

After binding, providers can also send `tools.update` to replace their own tool list without reconnecting. ※ tap validates the new definitions, rejects conflicts without changing the active list, and uses the same debounced `registerTools()` + extension reload path on success.

## Further reading

- [Core Profile spec](./docs/recipes/provider-interface-core-profile.md) — Full protocol specification with state machine, error codes, and payload limits
- [Test provider example](./examples/test-provider.mjs) — A runnable example you can try immediately
