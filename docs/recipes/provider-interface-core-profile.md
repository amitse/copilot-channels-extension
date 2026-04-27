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
| **Bound** | `tool.result`, `goodbye` | `tool.call`, `tool.cancel`, `session.lifecycle`, `error` |

---

## Authentication

Gateway passes a unique, short-lived token via `TAP_PROVIDER_TOKEN` env var at spawn time. Provider sends it as the first message:

```json
{ "type": "auth", "token": "ptk-a8f3..." }
```

**Success →** gateway sends `sessions`.  **Failure →** `error { code: "AUTH_FAILED" }`, connection closed.

---

## Messages (10 types)

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
{ "type": "hello.ack", "protocolVersion": 2, "providerId": "p-8f3a" }
```

`providerId` is a stable debug ID included in subsequent `error` messages.

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
| Gateway → Provider | `session.lifecycle` | State change | `goodbye` on shutdown (recommended) |
| Gateway → Provider | `error` | Invalid message | — |
| Provider → Gateway | `goodbye` | Before disconnect | — |

---

## What's not in Core

These are in the [full spec](./provider-interface-v2.md), not here:

- External/browser providers and pairing auth
- `"all"` session binding, `session.ready`
- Push events, streams, filters, `stream.query`
- Hooks, gates, transforms
- Dynamic updates (`tools.update`, `hooks.update`, `context.update`, `filter.set`)
- Multi-instance providers, reconnect tokens
- Update acknowledgments (`ack`, revisions)
- Concurrency limits, tool progress (`tool.progress`)
- Session events (`session.event`, `subscribe`)
