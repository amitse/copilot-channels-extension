# Provider Interface — The Contract Between Gateway and Providers

## The split

```
Extension (Gateway + Hook API)        Provider (tap, browser, anything)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Owns the Copilot SDK session          Knows nothing about Copilot SDK
Runs the WS server on :9400           Connects as WS client
Calls registerTools()                 Announces tool definitions
Executes hooks in-process             Sends hook rules
Holds EventStreams                    Pushes events
Manages session lifecycle             Stateless (can reconnect anytime)
```

One extension, installed once. Unlimited providers, no install needed.

## Provider lifecycle

```
Provider starts
    │
    ▼
Connect: ws://localhost:9400
    │
    ▼
Send: hello (name, tools, hooks, context)
    │
    ▼
Gateway registers tools + hook rules
    │
    ├─── Copilot calls a tool ──► Gateway sends: tool.call
    │                              Provider sends: tool.result
    │
    ├─── Provider pushes event ──► Gateway routes to session
    │
    ├─── Provider updates tools ──► Gateway re-registers
    │
    ▼
Disconnect (or crash)
    │
    ▼
Gateway removes provider's tools + hook rules
```

## Messages: Provider → Gateway

### `hello` — register as a provider

Sent immediately after connecting. Everything is optional except `name`.

```json
{
  "type": "hello",
  "name": "my-provider",
  "tools": [
    {
      "name": "my_tool",
      "description": "Does something useful",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        },
        "required": ["query"]
      }
    }
  ],
  "hooks": {
    "onPreToolUse": [
      {
        "match": { "tool": "shell", "args": "git push" },
        "action": "gate",
        "gateId": "check-before-push"
      }
    ],
    "transforms": {
      "code_change_rules": {
        "action": "append",
        "content": "Production deploy in progress. Be conservative."
      }
    }
  },
  "context": "This provider monitors CI status for the current branch."
}
```

### `tool.result` — respond to a tool invocation

```json
{
  "type": "tool.result",
  "id": "call-123",
  "data": { "user": "alice", "role": "admin" }
}
```

Or failure:

```json
{
  "type": "tool.result",
  "id": "call-123",
  "error": "Database connection refused"
}
```

### `push` — send an unsolicited event into the session

```json
{
  "type": "push",
  "event": "CI failed on test/auth.spec.ts — assertion error at line 42",
  "level": "inject"
}
```

Level controls delivery:
- `"inject"` — send into the conversation (session.send)
- `"surface"` — show in timeline (session.log)
- `"keep"` — store in EventStream only

### `tools.update` — change tool definitions

Add, remove, or replace tools without reconnecting:

```json
{
  "type": "tools.update",
  "tools": [
    { "name": "new_tool", "description": "Just appeared", "parameters": {} }
  ],
  "remove": ["old_tool"]
}
```

### `hooks.update` — change hook rules

```json
{
  "type": "hooks.update",
  "onPreToolUse": [
    {
      "match": { "tool": "edit", "file": "*.sql" },
      "action": "context",
      "content": "This is a SQL migration file. Ensure backward compatibility."
    }
  ],
  "transforms": {
    "code_change_rules": null
  }
}
```

Setting a transform to `null` removes it.

### `context.update` — change injected context

```json
{
  "type": "context.update",
  "context": "CI is now passing. Deploy v2.4.3 completed successfully."
}
```

This context is injected via `onUserPromptSubmitted` additionalContext.

### `gate.result` — respond to a hook gate check

When the gateway asks the provider to evaluate a gate:

```json
{
  "type": "gate.result",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "decision": "deny",
  "reason": "CI is failing on this branch. Fix tests first."
}
```

### `goodbye` — graceful disconnect

```json
{
  "type": "goodbye",
  "reason": "shutting down"
}
```

## Messages: Gateway → Provider

### `tool.call` — Copilot invoked one of your tools

```json
{
  "type": "tool.call",
  "id": "call-123",
  "tool": "my_tool",
  "args": { "query": "find active users" }
}
```

Provider must respond with `tool.result` using the same `id`.

### `gate.check` — a hook rule matched, provider must evaluate

```json
{
  "type": "gate.check",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "tool": "shell",
  "args": { "command": "git push origin main" }
}
```

Provider must respond with `gate.result`. If provider doesn't respond within timeout (5s default), gateway allows the action.

### `session.event` — forwarded session events (if subscribed)

```json
{
  "type": "session.event",
  "event": "user.message",
  "data": { "content": "fix the auth bug" }
}
```

Providers opt into events in their `hello`:

```json
{
  "type": "hello",
  "name": "my-provider",
  "subscribe": ["user.message", "assistant.message", "tool.execution_complete"]
}
```

### `session.lifecycle` — session state changes

```json
{ "type": "session.lifecycle", "state": "started" }
{ "type": "session.lifecycle", "state": "idle" }
{ "type": "session.lifecycle", "state": "shutdown" }
```

Always sent, no opt-in needed.

## Hook rules — the declarative API

Providers don't implement hooks directly (that requires the SDK). Instead they declare **rules** that the gateway evaluates in-process.

### onPreToolUse rules

```json
{
  "match": { "tool": "shell", "args": "git push" },
  "action": "deny",
  "reason": "Pushes blocked during deploy"
}
```

```json
{
  "match": { "tool": "edit", "file": "*.migration.*" },
  "action": "context",
  "content": "This is a database migration. Ensure it's reversible."
}
```

```json
{
  "match": { "tool": "shell", "args": "rm -rf" },
  "action": "gate",
  "gateId": "confirm-destructive"
}
```

Actions:
- `"deny"` — block the tool call with a reason (static)
- `"context"` — allow but inject additional context (static)
- `"gate"` — ask the provider to evaluate (dynamic, via `gate.check`/`gate.result`)

### Transform rules

```json
{
  "section": "code_change_rules",
  "action": "append",
  "content": "You are on the main branch. Be conservative."
}
```

```json
{
  "section": "custom_instructions",
  "action": "replace",
  "content": "Full custom instructions here..."
}
```

Actions: `"append"`, `"prepend"`, `"replace"`

Multiple providers can append to the same section. The gateway concatenates them in provider registration order.

## What a minimal provider looks like

### Node.js (50 lines)

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:9400");

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "hello",
    name: "hello-provider",
    tools: [{
      name: "say_hello",
      description: "Says hello to someone",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    }]
  }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === "tool.call" && msg.tool === "say_hello") {
    ws.send(JSON.stringify({
      type: "tool.result",
      id: msg.id,
      data: `Hello, ${msg.args.name}!`
    }));
  }
});
```

### Browser (injected via Detour, 40 lines)

```js
const ws = new WebSocket("ws://localhost:9400");

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "hello",
    name: "browser",
    tools: [{
      name: "page_title",
      description: "Get the current page title",
      parameters: {}
    }, {
      name: "page_screenshot",
      description: "Screenshot the current viewport",
      parameters: {}
    }]
  }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type !== "tool.call") return;

  if (msg.tool === "page_title") {
    ws.send(JSON.stringify({
      type: "tool.result", id: msg.id,
      data: document.title
    }));
  }

  if (msg.tool === "page_screenshot") {
    // Use html2canvas or canvas API
    html2canvas(document.body).then(canvas => {
      ws.send(JSON.stringify({
        type: "tool.result", id: msg.id,
        data: { image: canvas.toDataURL("image/png") }
      }));
    });
  }
};
```

### Python (30 lines)

```python
import asyncio, json, websockets

async def provider():
    async with websockets.connect("ws://localhost:9400") as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "name": "python-provider",
            "tools": [{
                "name": "compute",
                "description": "Run a Python expression",
                "parameters": {
                    "type": "object",
                    "properties": {"expr": {"type": "string"}},
                    "required": ["expr"]
                }
            }]
        }))

        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "tool.call" and msg["tool"] == "compute":
                try:
                    result = eval(msg["args"]["expr"])
                except Exception as e:
                    result = str(e)
                await ws.send(json.dumps({
                    "type": "tool.result",
                    "id": msg["id"],
                    "data": result
                }))

asyncio.run(provider())
```

## Summary: the interface

| Concern | Provider sends | Gateway sends |
|---|---|---|
| **Identity** | `hello` | — |
| **Tools** | `hello.tools`, `tools.update` | `tool.call` |
| **Tool results** | `tool.result` | — |
| **Events** | `push` | — |
| **Hook rules** | `hello.hooks`, `hooks.update` | `gate.check` |
| **Gate decisions** | `gate.result` | — |
| **Context** | `hello.context`, `context.update` | — |
| **Session events** | — | `session.event` (if subscribed) |
| **Lifecycle** | `goodbye` | `session.lifecycle` |

13 message types total. That's the full contract.
