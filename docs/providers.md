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
└─────────────────┘                              └─────────────────┘
```

## Quick start

### 1. Start a Copilot session

The gateway starts automatically on port 9400 when ※ tap loads. It generates an auth token and stores it in the `TAP_PROVIDER_TOKEN` environment variable.

### 2. Write a provider

A provider is any process that speaks the WebSocket protocol. Here's a minimal example in Node.js:

```js
import WebSocket from "ws";

const TOKEN = process.env.TAP_PROVIDER_TOKEN;
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
# In the terminal where Copilot is running, grab the token:
echo $TAP_PROVIDER_TOKEN   # macOS/Linux
echo %TAP_PROVIDER_TOKEN%  # Windows

# In another terminal, start the provider:
TAP_PROVIDER_TOKEN=ptk-... node my-provider.mjs
```

Once connected, the `greet` tool appears in Copilot alongside the existing ※ tap tools. Ask Copilot to use it:

> _"Use the greet tool to say hello to Alice"_

## Connection lifecycle

```
AwaitAuth ──auth──► AwaitHello ──hello──► Bound ──goodbye/disconnect──► Disconnected
```

1. **AwaitAuth** — Provider sends `auth` with the token. Gateway responds with `sessions` (list of active sessions).
2. **AwaitHello** — Provider sends `hello` with its name, protocol version, session choice, and tool definitions. Gateway responds with `hello.ack`.
3. **Bound** — Provider receives `tool.call` messages and responds with `tool.result`. Gateway sends `session.lifecycle` events.
4. **Disconnected** — On `goodbye`, WebSocket close, or crash. All tools are removed and in-flight calls fail.

## Message reference

| Direction | Type | When |
|---|---|---|
| Provider → Gateway | `auth` | First message — send the token |
| Gateway → Provider | `sessions` | After auth — pick a session |
| Provider → Gateway | `hello` | After sessions — register tools |
| Gateway → Provider | `hello.ack` | Bound — tools are live |
| Gateway → Provider | `tool.call` | Copilot invokes your tool |
| Provider → Gateway | `tool.result` | Your response (exactly one per call) |
| Gateway → Provider | `tool.cancel` | Timeout/interrupt — respond with `CANCELLED` |
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

## Error handling

| Code | Fatal? | Meaning |
|---|---|---|
| `AUTH_FAILED` | Yes | Bad token — connection closes |
| `UNSUPPORTED_VERSION` | Yes | Wrong `protocolVersion` — connection closes |
| `INVALID_SESSION` | No | Session ID doesn't exist — pick another |
| `TOOL_CONFLICT` | No | Tool name already taken — rename and retry |
| `PAYLOAD_TOO_LARGE` | No | Message exceeds size limit |

Payload limits: `tool.result` max 5 MB, all other messages max 2 MB.

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

## Further reading

- [Core Profile spec](./docs/recipes/provider-interface-core-profile.md) — Full protocol specification with state machine, error codes, and payload limits
- [Test provider example](./examples/test-provider.mjs) — A runnable example you can try immediately
