# Provider Interface — The Contract Between Gateway and Providers

## The split

```
Extension (Gateway + Hook API)        Provider (tap, browser, anything)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Owns the Copilot SDK sessions         Knows nothing about Copilot SDK
Runs the WS server on :9400           Connects as WS client
Calls registerTools() per session     Announces tool definitions
Executes hooks in-process             Sends hook rules
Holds EventStreams                    Pushes events
Manages session lifecycle             Stateless (can reconnect anytime)
Tracks multiple sessions              Optionally picks a session
```

One extension, installed once. Unlimited providers, no install needed.

## Session binding

The gateway manages multiple concurrent Copilot sessions. Providers are bound to sessions:

| Provider type | Session binding | Who decides |
|---|---|---|
| **Internal** (spawned by gateway from project config) | Bound to the session that started it | Automatic — gateway stamps it, provider never sees a session ID |
| **External** (self-connects via WS) | Picks a session from the list, or binds to all | Provider decides, using session list from gateway |

### How external providers discover sessions

On connect, the gateway sends a `sessions` message listing all active sessions:

```json
{
  "type": "sessions",
  "active": [
    { "id": "abc123", "label": "PR #42 review", "cwd": "/code/foo" },
    { "id": "def456", "label": "feature/auth", "cwd": "/code/bar" }
  ]
}
```

The provider picks one (e.g., shows a UI picker to the user) and includes it in `hello`:

```json
{ "type": "hello", "name": "browser", "session": "abc123", "tools": [...] }
```

Or broadcasts to all sessions:

```json
{ "type": "hello", "name": "browser", "session": "all", "tools": [...] }
```

Internal providers don't need to pick — the gateway fills in the session ID automatically. The provider just sends:

```json
{ "type": "hello", "name": "ci-watcher", "tools": [...] }
```

And the gateway binds it to the session that spawned it.

### What "bound to a session" means

- Provider's tools are registered only in that session (`registerTools()` scoped)
- Provider's `push` events are injected into that session only
- Provider's hook rules apply to that session only
- When `session: "all"`, tools/events/hooks are registered in every active session

## Provider lifecycle

```
Provider starts
    │
    ▼
Connect: ws://localhost:9400
    │
    ▼
Receive: sessions (list of active Copilot sessions)
    │
    ▼
Send: hello (name, session, tools, hooks, context)
    │
    ▼
Gateway registers tools + hook rules in the bound session(s)
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

Sent immediately after receiving the `sessions` list. Everything is optional except `name`.

For external providers, `session` selects which Copilot session to bind to (`"all"` for broadcast). For internal providers (spawned by the gateway), omit `session` — the gateway fills it in automatically.

```json
{
  "type": "hello",
  "name": "my-provider",
  "session": "abc123",
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

### Browser (injected via Detour, with session picker)

```js
const ws = new WebSocket("ws://localhost:9400");
let sessions = [];

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  // Gateway sends session list on connect
  if (msg.type === "sessions") {
    sessions = msg.active;
    if (sessions.length === 1) {
      // Only one session — auto-bind
      register(sessions[0].id);
    } else if (sessions.length > 1) {
      // Multiple sessions — show picker
      showSessionPicker(sessions, (chosen) => register(chosen.id));
    }
    return;
  }

  // Handle tool calls
  if (msg.type === "tool.call") {
    if (msg.tool === "page_title") {
      ws.send(JSON.stringify({
        type: "tool.result", id: msg.id,
        data: document.title
      }));
    }
  }
};

function register(sessionId) {
  ws.send(JSON.stringify({
    type: "hello",
    name: "browser",
    session: sessionId,
    tools: [
      { name: "page_title", description: "Get the current page title", parameters: {} },
      { name: "page_screenshot", description: "Screenshot the viewport", parameters: {} }
    ]
  }));
}

function showSessionPicker(sessions, onPick) {
  // Small overlay UI — the provider decides how to present this
  const el = document.createElement("div");
  el.innerHTML = sessions.map(s =>
    `<button data-id="${s.id}">${s.label} (${s.cwd})</button>`
  ).join("");
  el.addEventListener("click", (e) => {
    const id = e.target.dataset.id;
    if (id) { onPick(sessions.find(s => s.id === id)); el.remove(); }
  });
  document.body.appendChild(el);
}
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
| **Sessions** | — | `sessions` (on connect, lists active sessions) |
| **Identity** | `hello` (includes `session` binding) | — |
| **Tools** | `hello.tools`, `tools.update` | `tool.call` |
| **Tool results** | `tool.result` | — |
| **Events** | `push` | — |
| **Hook rules** | `hello.hooks`, `hooks.update` | `gate.check` |
| **Gate decisions** | `gate.result` | — |
| **Context** | `hello.context`, `context.update` | — |
| **Session events** | — | `session.event` (if subscribed) |
| **Lifecycle** | `goodbye` | `session.lifecycle` |

14 message types total. That's the full contract.
