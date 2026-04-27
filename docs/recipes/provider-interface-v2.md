# Provider Interface v2 — The Contract Between Gateway and Providers

## Quickstart: build a provider in 5 minutes

A provider is any process that connects to the gateway and exposes tools. Here's the complete happy path:

```
1. Connect:    ws://localhost:9400
2. Auth:       { "type": "auth", "token": "<your TAP_PROVIDER_TOKEN>" }
3. Receive:    { "type": "sessions", "active": [...] }
4. Register:   { "type": "hello", "name": "my-provider", "protocolVersion": 2,
                  "session": "<pick one from sessions>", "tools": [...] }
5. Receive:    { "type": "hello.ack", "providerId": "p-xxx", ... }
6. Handle:     { "type": "tool.call", "id": "c-1", "tool": "my_tool", "args": {...} }
7. Respond:    { "type": "tool.result", "id": "c-1", "data": "result" }
8. If cancel:  { "type": "tool.cancel", "id": "c-1" }
   Respond:    { "type": "tool.result", "id": "c-1", "errorCode": "CANCELLED" }
```

That's it for a simple tool provider. **If you only want to expose tools, you can ignore**: hooks, transforms, push events, streams, filters, multi-instance, `"all"` binding, and reconnect tokens.

### Minimal Node.js provider (complete, correct)

```js
import WebSocket from "ws";

const TOKEN = process.env.TAP_PROVIDER_TOKEN;
const ws = new WebSocket("ws://localhost:9400");

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === "sessions") {
    ws.send(JSON.stringify({
      type: "hello",
      name: "my-provider",
      protocolVersion: 2,
      session: msg.active[0]?.id ?? "all",
      tools: [{
        name: "greet",
        description: "Say hello",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
      }]
    }));
  }

  if (msg.type === "tool.call" && msg.tool === "greet") {
    ws.send(JSON.stringify({ type: "tool.result", id: msg.id, data: `Hello, ${msg.args.name}!` }));
  }

  if (msg.type === "tool.cancel") {
    ws.send(JSON.stringify({ type: "tool.result", id: msg.id, error: "Cancelled", errorCode: "CANCELLED" }));
  }

  if (msg.type === "error") {
    console.error(`Gateway error: ${msg.code} — ${msg.message}`);
  }
});
```

### What's optional (ignore until you need it)

| Feature | When you need it |
|---|---|
| Push events | You want to proactively send data into the Copilot session |
| Hook rules / transforms | You want to gate or modify tool calls, or inject into the system prompt |
| Streams / filters | You produce continuous output that needs noise filtering |
| Multi-instance | Multiple instances of your provider run simultaneously (e.g., browser tabs) |
| `"all"` binding | Your provider serves multiple Copilot sessions at once |
| Reconnect tokens | Your provider may disconnect and reconnect mid-session |

---

## The split

```
Extension (Gateway)                   Provider (tap, browser, anything)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Owns the Copilot SDK sessions         Knows nothing about Copilot SDK
Runs the WS server on :9400           Connects as WS client
Calls registerTools() per session     Announces tool definitions
Executes hooks in-process             Sends hook rules (declarative)
Holds EventStreams                    Pushes events, queries streams
Manages session lifecycle             Stateless (can reconnect anytime)
Tracks multiple sessions              Optionally picks a session
```

One extension, installed once. Unlimited providers, no install needed.

## Transport abstraction

The provider interface is a message contract, not a wire format. Two transports implement it:

```
Gateway process
├── WsProviderTransport   → JSON over WebSocket (external providers)
├── LocalProviderTransport → direct function calls (in-process providers)
└── tap runtime (uses LocalProviderTransport — same contract, no serialization)
```

External providers connect via `ws://localhost:9400`. In-process providers (like tap) use direct method calls with the same message shapes. The gateway treats both identically for registration, tool dispatch, and hook evaluation.

---

## Multi-session model

### The problem

Multiple Copilot CLI sessions can run simultaneously on the same machine (different terminals, different projects). Each session loads the gateway extension. Only one can bind the WS port.

### The solution: shared gateway with session registry

```
Terminal 1: copilot (project-foo)
  └─ Gateway extension starts
       └─ Tries to bind :9400 → success → becomes the gateway owner
       └─ Registers session "abc" (cwd: /code/foo)

Terminal 2: copilot (project-bar)
  └─ Gateway extension starts
       └─ Tries to bind :9400 → EADDRINUSE
       └─ Connects to existing gateway as an internal client
       └─ Registers session "def" (cwd: /code/bar)

Both sessions are now managed by the single gateway on :9400.
```

### Session registry

The gateway maintains a registry of active sessions:

```json
[
  { "id": "abc", "label": "PR #42 review", "cwd": "/code/foo", "foreground": true },
  { "id": "def", "label": "feature/auth", "cwd": "/code/bar", "foreground": false }
]
```

### What happens when sessions come and go

| Event | Gateway behavior |
|---|---|
| **New session registers** | Added to registry. Gateway sends `sessions.updated` to all connected providers. Internal providers spawned from that session's config are bound to it. |
| **Session ends** | Removed from registry. Internal providers bound to it are stopped. External providers bound to it receive `session.lifecycle: shutdown.pending` with a deadline. Providers bound to `"all"` remain connected for other sessions but still receive `shutdown.pending` for the ended session and must send `shutdown.ready`. Gateway sends `sessions.updated` to all providers. |
| **Gateway-owning session ends** | If other sessions remain, gateway ownership transfers — the WS server keeps running. If no sessions remain, the gateway shuts down. |
| **All sessions end** | Gateway shuts down. WS server closes. External providers disconnect. |
| **External provider is bound to a session that ends** | Provider receives `session.lifecycle: shutdown.pending`. Its tools are deregistered from that session. The provider stays connected and can re-bind to another session via a new `hello`. |

### Provider perspective

Providers never manage sessions. They see:

1. `sessions` message on connect — list of active sessions
2. `sessions.updated` when sessions come or go — updated list
3. They pick a session in `hello` (or `"all"`)
4. If their session ends, they get `session.lifecycle: shutdown.pending` and can re-bind

---

## Session binding

| Provider type | Session binding | Who decides |
|---|---|---|
| **Internal** (spawned by gateway from project config) | Bound to the session that started it | Automatic — gateway stamps it |
| **External** (self-connects via WS) | Picks a session, or `"all"` | Provider decides, using session list from gateway |
| **In-process** (tap, via LocalProviderTransport) | Bound to its session | Automatic — same process |

### What "bound to a session" means

- Provider's tools are registered only in that session's `registerTools()` call
- Provider's `push` events are injected into that session only
- Provider's hook rules apply to that session only
- Provider's transforms apply to that session only
- When `session: "all"`, everything is registered in every active session

---

## Provider lifecycle

```
Provider connects via WS
    │
    ▼
Provider sends: auth (gateway secret)
    │
    ▼
Gateway sends: sessions (list of active sessions)
    │
    ▼
Provider sends: hello (name, session, instance, tools, hooks, context)
    │
    ▼
Gateway sends: hello.ack (reconnectToken, persistDir)
    │
    ▼
Gateway registers tools + hook rules in the bound session(s)
    │
    ├─── Copilot calls a tool ──► Gateway sends: tool.call
    │                              Provider sends: tool.result
    │
    ├─── Transform needed ──► Gateway sends: transform.request
    │                          Provider sends: transform.result
    │
    ├─── Gate check needed ──► Gateway sends: gate.check
    │                           Provider sends: gate.result
    │
    ├─── Provider pushes event ──► Gateway routes to session
    │
    ├─── Provider updates tools ──► Gateway re-registers
    │
    ├─── Sessions change ──► Gateway sends: sessions.updated
    │
    ▼
Session ending:
    Gateway sends: session.lifecycle (shutdown.pending, deadline)
    Provider does async cleanup
    Provider sends: shutdown.ready
    Gateway proceeds with teardown

Disconnect (or crash):
    Gateway removes provider's tools + hook rules from bound session(s)
```

---

## Protocol rules

### Version negotiation

Provider includes `protocolVersion` in `hello`. Gateway includes `protocolVersion` in `hello.ack`.

```json
// hello
{ "type": "hello", "name": "...", "protocolVersion": 2, ... }

// hello.ack
{ "type": "hello.ack", "protocolVersion": 2, "providerId": "p-8f3a", ... }
```

- If the gateway does not support the requested version, it sends `error` with code `UNSUPPORTED_VERSION` and closes the connection.
- Receivers MUST ignore unknown fields in any message (forward-compatible).
- Receivers MUST ignore unknown message types (log and discard, do not disconnect).
- New optional message types or fields can be added in minor versions without negotiation. New required behavior requires a major version bump.

### Provider identity

Gateway assigns a stable `providerId` in `hello.ack`. This ID is included in `error` messages and can be used for debugging. It persists across reconnects (same `reconnectToken` → same `providerId`).

### Authentication and trust levels

The gateway uses a **tiered trust model**, not a single shared secret.

#### Trust levels

| Level | Who | Capabilities | How authenticated |
|---|---|---|---|
| **internal** | In-process providers (tap) | Full: all sessions, all hooks, all transforms | LocalProviderTransport — no auth needed |
| **project** | Spawned from `tap.config.json` | Bound to spawning session, tools + push + gates + context | Per-provider token issued at spawn time via env `TAP_PROVIDER_TOKEN` |
| **external** | Self-connecting processes | Tools + push only. No transforms, no hook callbacks, no cross-provider streams | User-approved pairing flow |

#### Internal providers

LocalProviderTransport — in-process, fully trusted, no auth message needed.

#### Project providers

Gateway generates a unique, short-lived token per provider at spawn time, passed as `TAP_PROVIDER_TOKEN` env var. Provider sends it in `auth`:

```json
{ "type": "auth", "token": "ptk-a8f3..." }
```

Token is scoped to the spawning session. Provider cannot access other sessions.

#### External providers (browser, standalone scripts)

External providers use a **user-approved pairing flow**:

1. Provider connects via WS and sends: `{ "type": "auth", "mode": "pair" }`
2. Gateway generates a 6-digit pairing code and shows it in the Copilot session timeline via `session.log()`:
   ```
   ※ tap: Provider 'browser' requesting access. Pairing code: 847293
   ```
3. Provider shows the code to the user (e.g., browser overlay). User confirms they match.
4. Provider sends: `{ "type": "auth.confirm", "code": "847293" }`
5. Gateway issues a short-lived provider token in `sessions` response.
6. On reconnect, provider uses the issued token (valid for the session lifetime, not persisted across gateway restarts).

This prevents silent hijacking by malicious tabs or npm packages — the user must visually confirm the pairing.

#### Identity protection

Provider identity (`name` + `instance`) is bound to the issued token. Only a connection with a valid `reconnectToken` can take over an existing identity — the gateway closes the old connection and transfers the binding. A new connection claiming the same identity **without** a valid `reconnectToken` gets `error` with code `DUPLICATE_INSTANCE` and the existing connection is unaffected.

### Provider capabilities

Each trust level has a fixed capability set. The gateway enforces these on every message:

| Capability | internal | project | external |
|---|---|---|---|
| Register tools | ✓ | ✓ | ✓ |
| Push events (inject/surface/keep) | ✓ | ✓ | ✓ |
| Register hook gate rules | ✓ | ✓ | ✗ |
| Register transform callbacks | ✓ | ✓ | ✗ |
| Register static transforms (append) | ✓ | ✓ | ✓ |
| Query own streams | ✓ | ✓ | ✓ |
| Query cross-provider streams | ✓ | ✗ | ✗ |
| Subscribe to session events | ✓ | ✓ | tools only |
| Bind to any session / "all" | ✓ | ✗ (spawning session only) | ✗ (paired session only) |
| Set context / startup_context | ✓ | ✓ | ✗ |

Unauthorized messages receive `error` with code `UNAUTHORIZED`.

### Protected prompt sections

The system prompt sections `safety` and `identity` are **immutable** — no provider can replace or prepend to them, regardless of trust level. Providers can only `append` to these sections. The gateway applies provider transforms BEFORE the protected sections, ensuring safety content always has the last word.

### Session IDs and correlation IDs

All `id` and `callId` values are **globally unique** (UUIDs or equivalent). A provider can safely correlate responses without `sessionId` because IDs never collide across sessions.

All session-scoped gateway→provider messages include `sessionId`:

- `session.lifecycle`, `session.event`, `tool.call`, `tool.cancel`, `gate.check`, `transform.request`

Provider→gateway responses do NOT need `sessionId` — the gateway correlates via the globally unique `id`/`callId`. Exception: `shutdown.ready` includes `sessionId` because it's not a response to a specific call.

### Error responses

The gateway sends `error` for any invalid message:

```json
{
  "type": "error",
  "code": "INVALID_SESSION",
  "message": "Session def456 does not exist",
  "replyTo": "hello"
}
```

Error codes: `INVALID_JSON`, `UNKNOWN_TYPE`, `INVALID_SESSION`, `AUTH_FAILED`, `DUPLICATE_INSTANCE`, `TOOL_CONFLICT`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_VERSION`, `UNAUTHORIZED`.

Errors include `providerId` and `sessionId` when applicable for debugging:

```json
{
  "type": "error",
  "code": "TOOL_CONFLICT",
  "message": "Tool 'screenshot' already registered by provider 'browser-tab-a'",
  "replyTo": "tools.update",
  "providerId": "p-8f3a",
  "sessionId": "abc123"
}
```

#### Error recovery guide

| Code | Fatal? | What to do |
|---|---|---|
| `AUTH_FAILED` | Yes | Connection will close. Re-pair or check `TAP_PROVIDER_TOKEN`. |
| `UNSUPPORTED_VERSION` | Yes | Connection will close. Update your provider to a supported protocol version. |
| `INVALID_SESSION` | No | Session doesn't exist or you're not authorized. Wait for `sessions.updated`, then send new `hello`. |
| `DUPLICATE_INSTANCE` | No | Another connection has this `name`+`instance`. Pick a new `instance` or reconnect with `reconnectToken`. |
| `TOOL_CONFLICT` | No | Rename the conflicting tool and send `tools.update`. |
| `PAYLOAD_TOO_LARGE` | No | Compress/downscale the payload, or use a file ref (local providers only). Retry with smaller data. |
| `RATE_LIMITED` | No | Back off. Retry after 1 second. |
| `UNAUTHORIZED` | No | Your trust level doesn't allow this operation. Check the capability matrix. |
| `INVALID_JSON` | No | Fix the malformed message and retry. |
| `UNKNOWN_TYPE` | No | Gateway doesn't recognize this message type. Check protocol version. |

### Update acknowledgments

All state-changing provider→gateway messages (`tools.update`, `hooks.update`, `context.update`, `filter.set`) MUST include a provider-supplied `requestId`. The gateway responds with `ack`:

```json
// Provider sends:
{ "type": "tools.update", "requestId": "req-42", "sessionId": "abc123", "tools": [...] }

// Gateway responds:
{ "type": "ack", "requestId": "req-42", "sessionId": "abc123", "revision": 3 }
```

- `requestId` — provider-chosen, echoed in `ack` for correlation
- `sessionId` — which session this revision applies to. If the update targeted all sessions (omitted `sessionId`), the gateway sends one `ack` per session.
- `revision` — monotonically increasing per (provider, session). After a provider receives `ack` with revision N, the gateway guarantees all subsequent dispatches to that session use revision N state.

Only one state update per (provider, session, message type) can be in-flight at a time. Sending a second `tools.update` for the same session before the first is acked results in `error` with code `RATE_LIMITED`.

On failure, the gateway sends `error` with the same `requestId` instead of `ack`.

### Tool concurrency

Providers can declare concurrency limits in `hello`:

```json
{
  "type": "hello",
  "name": "browser",
  "concurrency": { "max": 1, "scope": "instance" },
  ...
}
```

- `max` — maximum concurrent in-flight `tool.call`s (default: unlimited)
- `scope` — what the limit applies to: `"instance"` (per name+instance), `"provider"` (all instances), or `"tool"` (per tool name)

When the limit is reached, the gateway queues additional calls and dispatches them in order as results arrive. If the queue exceeds 10, the gateway returns `errorCode: "RATE_LIMITED"` to Copilot for new calls.

### Tool name collisions

- Two providers CANNOT register the same tool name in the same session. Second registration gets `error` with code `TOOL_CONFLICT`.
- Multi-instance providers (same `name`, different `instance`) share tool names — the gateway merges them with auto-injected `target` parameter (see Multi-instance section).
- Provider tool names MUST NOT start with `list_` followed by another provider's name (reserved for auto-generated meta-tools).

### Terminal message ordering for tool calls

A tool call has one terminal state. The first terminal message wins:

- `tool.result` arrives → call is complete. Any later `tool.result` for the same `id` is ignored.
- `tool.cancel` sent → provider MUST respond with `tool.result { errorCode: "CANCELLED" }` as the terminal state. If a non-cancelled `tool.result` arrives after `tool.cancel`, gateway ignores it.
- Provider disconnects with in-flight calls → gateway returns `errorCode: "DISCONNECTED"` to Copilot. The call is NOT replayed on reconnect.

### Gate timeout behavior: fail closed

Gates default to **deny** on timeout, not allow. A provider that registers a gate is asserting safety invariants. Silence = don't proceed.

```
gate.check sent → 5s timeout → no gate.result → permissionDecision: "deny"
  reason: "Gate provider 'ci-watcher' did not respond in time."
```

Providers can opt into fail-open per gate rule: `{ "action": "gate", "gateId": "...", "failOpen": true }`.

If a provider **disconnects** with a pending `gate.check`, the gate is denied (fail closed). Pending `transform.request` calls fall back to `current` content unchanged on disconnect.

### Reconnect protocol

1. Gateway generates `reconnectToken` in `hello.ack`. Token is valid for 30 seconds.
2. On reconnect, provider includes `reconnectToken` in `hello`. Gateway:
   - Validates the token against the original identity (`name` + `instance`)
   - Closes the old connection if still open
   - Restores provider binding (session, tools, hooks)
3. Any in-flight `tool.call` at disconnect time is **failed** with `errorCode: "DISCONNECTED"` (not replayed). The provider starts clean.
4. Token expires after 30s — reconnect after that is a fresh `hello` (full re-auth required).
5. Without a valid `reconnectToken`, a new connection claiming an existing identity gets `DUPLICATE_INSTANCE`. See Identity Protection.

### Push loop prevention

The gateway enforces push budgets scoped by **(provider, sessionId)**:
- Max 10 `push` messages per second per (provider, session).
- A `push` with `level: "inject"` triggers an AI turn. The gateway will not deliver another `inject`-level push from the same provider to the same session until that session becomes idle.
- After 3 consecutive inject→response→inject cycles from the same provider in the same session, the gateway pauses that provider's inject pushes to that session and logs a warning.

### Stream access control

- All providers can query their **own** streams via `stream.query`.
- Cross-provider stream reads require **internal** trust level. Project and external providers cannot read other providers' streams.
- `filter.set` only works on the provider's own streams.
- The gateway enforces these per-message based on the provider's trust level.

### Session scope enforcement

The gateway MUST reject any session-scoped provider→gateway message (`push`, `tools.update`, `hooks.update`, `context.update`, `filter.set`, `stream.query`, `session.ready`, `shutdown.ready`) where the `sessionId` is outside the provider's authorized session set. Violation returns `error` with code `INVALID_SESSION`.

### Payload limits

- Max message size: **5 MB** for `tool.result` messages (screenshots, large outputs). **2 MB** for all other messages.
- For payloads exceeding 5 MB, local providers should write to `persistDir` and return a file reference:
  ```json
  { "type": "tool.result", "id": "call-123", "file": { "path": "/home/user/.copilot/providers/browser/screenshot-abc.png", "mimeType": "image/png", "size": 8421000, "ttl": 300 } }
  ```
  - `path` — absolute path on the local filesystem. Must be within the provider's `persistDir`.
  - `mimeType` — MIME type for the gateway to pass to Copilot.
  - `size` — byte size.
  - `ttl` — seconds until the provider may delete the file. Gateway must read it before TTL expires.
  - Browser providers cannot use file refs (no filesystem access). Browser screenshots should be downscaled or compressed to stay within the 5 MB inline limit.
- Max tools per provider: **100**.
- Max hook rules per provider: **50**.
- Max streams per provider: **20**.
- EventStream retention: **200 events** per stream (oldest evicted).
- `stream.query` max `last`: **100**.
- Max concurrent WS connections: **50**. New connections beyond this are rejected.
- Max pairing attempts per minute: **5**. Prevents brute-force of pairing codes.
- Max `hello` rebinds per connection per minute: **10**. Prevents identity-churn attacks.

### `"all"` binding and session churn

When a provider is bound to `"all"`:
- Its tools and context are registered in all **currently active** sessions at `hello` time.
- When a new session starts, the gateway sends `sessions.updated` to the provider but does **NOT** register tools/hooks/context in the new session yet. The provider must explicitly acknowledge readiness:
  ```json
  { "type": "session.ready", "sessionId": "new-session-id" }
  ```
  Only after `session.ready` does the gateway register the provider's tools/hooks/context in that session. This gives the provider time to initialize session-specific state, caches, or auth. If the provider never sends `session.ready`, its tools never appear in that session.
- **Fail-closed gate rules** are also deferred until `session.ready`.
- When a session ends, the provider receives `session.lifecycle: shutdown.pending` with that session's `sessionId`. After cleanup, provider sends `shutdown.ready` with the same `sessionId`. The provider remains connected for other sessions.

### Gateway process model

The gateway runs as a **detached background process**, not inside any single Copilot session's extension process.

1. First Copilot session starts → extension checks if gateway is running (attempts WS connect to `:9400`).
2. Not running → extension spawns the gateway as a detached process (survives session end). Extension connects to it as an internal client registering its session.
3. Already running → extension connects and registers its session.
4. Gateway exits when the last session disconnects (after a **30s** grace period — matches reconnect token TTL, so reconnecting providers and late-arriving sessions have time).

### Gateway crash recovery

If the gateway process crashes:

1. All WS connections drop. Providers detect disconnect via WS `onclose`.
2. All session registrations, provider bindings, reconnect tokens, and revision counters are lost (not persisted).
3. The next Copilot session start (or an existing session's heartbeat failure) spawns a new gateway.
4. Providers must treat a gateway restart as a **fresh connection**: re-authenticate, send a new `hello`, re-register tools. `reconnectToken` from the old gateway is invalid.
5. Copilot sessions must re-register themselves with the new gateway.

The gateway is designed to be **stateless and reconstructable**. All durable state lives in providers (their own config files) and sessions (Copilot SDK session state). The gateway is a relay, not a store.

### Ordering guarantees

- **Per-connection FIFO**: messages on a single WS connection are delivered in send order (guaranteed by WebSocket/TCP). LocalProviderTransport provides the same guarantee via synchronous dispatch.
- **No total ordering across sessions**: messages for session A and session B on the same provider connection may interleave freely.
- **Per-call terminal semantics**: for a given `tool.call` ID, only the first terminal message (`tool.result` or gateway-generated `DISCONNECTED`/`CANCELLED`) is accepted.
- **Revision barrier**: after `ack(revision=N)` for a (provider, session), all subsequent dispatches to that session use revision N state. No dispatch uses stale state.
- **Rebind barrier**: when a provider sends a new `hello` (rebind), the gateway completes removal of old state before processing the new registration. No dispatches from the old binding arrive after rebind starts.

### Connection states

A provider connection has these states:

```
Connected → AwaitAuth → AwaitPairing (external only) → AwaitHello → Bound → Disconnected
                                                                      ↕
                                                                   Rebinding
                                                                      ↓
                                                              Unbound (on error)
```

Legal messages per state:

| State | Legal provider messages |
|---|---|
| `AwaitAuth` | `auth` only |
| `AwaitPairing` | `auth.confirm` only |
| `AwaitHello` | `hello` only |
| `Bound` | All provider→gateway messages |
| `Rebinding` | None (gateway is processing) |
| `Unbound` | `hello`, `goodbye` only |

### Regex execution safety

- `match.args` patterns are compiled with a **1ms execution timeout** (per match attempt). Catastrophic backtracking is terminated.
- Stringification format for args: `JSON.stringify(args)`. Deterministic across runtimes.
- `filter.set` rules use the same regex engine with the same timeout.

---

## Messages: Gateway → Provider

### `auth.pairing` — pairing code for external providers

Sent after receiving `{ "type": "auth", "mode": "pair" }` from an external provider.

```json
{
  "type": "auth.pairing",
  "code": "847293"
}
```

The gateway displays the same code in the Copilot session timeline. The provider shows it to the user. After user confirms, provider sends `auth.confirm`. On success, gateway sends `sessions`.

### `sessions` — active session list (sent after successful auth)

```json
{
  "type": "sessions",
  "active": [
    { "id": "abc123", "label": "PR #42 review", "cwd": "/code/foo" },
    { "id": "def456", "label": "feature/auth", "cwd": "/code/bar" }
  ]
}
```

### `sessions.updated` — session list changed

Same shape as `sessions`. Sent when a session starts or ends.

### `hello.ack` — registration acknowledged

```json
{
  "type": "hello.ack",
  "protocolVersion": 2,
  "providerId": "p-8f3a",
  "reconnectToken": "tok-xyz789",
  "persistDir": "/home/user/.copilot/providers/my-provider/"
}
```

- `reconnectToken` — include in future `hello` to restore binding after disconnect
- `persistDir` — filesystem path for cross-session state (local providers only)

### `tool.call` — Copilot invoked a provider's tool

```json
{
  "type": "tool.call",
  "id": "call-123",
  "sessionId": "abc123",
  "tool": "my_tool",
  "args": { "query": "find active users" }
}
```

### `tool.cancel` — abort an in-flight tool call

```json
{
  "type": "tool.cancel",
  "id": "call-123",
  "sessionId": "abc123",
  "reason": "timeout"
}
```

Sent when a tool call exceeds its timeout or the session is interrupted. Provider should abort and send `tool.result` with `errorCode: "CANCELLED"` as the terminal state.

### `gate.check` — a hook rule matched, provider evaluates

```json
{
  "type": "gate.check",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "sessionId": "abc123",
  "tool": "shell",
  "args": { "command": "git push origin main" }
}
```

Timeout: 5s. If no response, gateway **denies** the action (fail closed). See Protocol Rules.

### `transform.request` — dynamic transform callback

Sent during `onUserPromptSubmitted` when a provider registered a `"callback"` transform.

```json
{
  "type": "transform.request",
  "callId": "tx-789",
  "sessionId": "abc123",
  "section": "custom_instructions",
  "current": "...existing section content..."
}
```

Timeout: 2s. Falls back to `current` unchanged if no response.

### `session.event` — forwarded session events (if subscribed)

```json
{
  "type": "session.event",
  "sessionId": "abc123",
  "event": "user.message",
  "data": { "content": "fix the auth bug" }
}
```

#### Event payload shapes

| Event | Payload |
|---|---|
| `user.message` | `{ content: string }` |
| `assistant.message` | `{ content: string, toolRequests?: [{ name, args }] }` |
| `tool.execution_complete` | `{ tool: string, provider?: string, args: object, result: { type: "success"\|"failure", output?: string }, durationMs: number }` |
| `assistant.intent` | `{ intent: string }` |

Providers opt into events in `hello.subscribe`:

```json
{ "subscribe": ["user.message", "assistant.message", "tool.execution_complete"] }
```

### `session.lifecycle` — session state changes

```json
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "started" }
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "idle" }
{ "type": "session.lifecycle", "sessionId": "abc123", "state": "shutdown.pending", "deadline": 10000 }
```

Always sent, no opt-in needed.

- `started` — session is ready
- `idle` — session is idle (no in-flight work). Providers can use this to trigger scheduled work.
- `shutdown.pending` — session is ending. Provider has `deadline` milliseconds to do async cleanup, then send `shutdown.ready`. Gateway tears down after deadline even if no response.

### Rebinding (repeat `hello` on existing connection)

A provider can send a new `hello` on an existing connection to change its session binding (e.g., after its session ends). Behavior:

1. Gateway atomically removes the provider's tools/hooks/context from the old session(s).
2. Gateway cancels any in-flight `tool.call`, `gate.check`, or `transform.request` for this provider.
3. Gateway processes the new `hello` as a fresh registration (validates session, registers tools).
4. Gateway sends a new `hello.ack` with a new `reconnectToken`.
5. If the new `hello` fails validation, gateway sends `error` and the provider remains unbound (connected but not registered to any session).

### `stream.history` — response to stream query

```json
{
  "type": "stream.history",
  "queryId": "q-1",
  "streams": {
    "ci-watch@ci-watcher": [
      { "ts": "2026-04-26T14:01:00Z", "event": "failure on test/auth.spec.ts" },
      { "ts": "2026-04-26T14:00:00Z", "event": "running" }
    ],
    "git-watch@guardian": [
      { "ts": "2026-04-26T14:00:30Z", "event": "behind=2" }
    ]
  }
}
```

Stream keys use `stream@provider` format matching the query.

---

## Messages: Provider → Gateway

### `auth` — authenticate on connect

```json
{ "type": "auth", "token": "ptk-a8f3..." }
```

For project providers (spawned by gateway). Or for external providers using the pairing flow:

```json
{ "type": "auth", "mode": "pair" }
```

Gateway responds with `auth.pairing` (external) or `sessions` (project/token).

### `auth.confirm` — confirm pairing code

```json
{ "type": "auth.confirm", "code": "847293" }
```

Sent by external providers after receiving `auth.pairing` and the user has verified the code matches. Gateway responds with `sessions` on success, `error` with `AUTH_FAILED` on wrong code.

### `hello` — register as a provider

```json
{
  "type": "hello",
  "name": "my-provider",
  "protocolVersion": 2,
  "session": "abc123",
  "instance": "tab-a3f8",
  "reconnectToken": "tok-xyz789",
  "startup_context": "Provider loaded. Monitoring 3 endpoints.",
  "metadata": {
    "url": "https://app.example.com",
    "title": "Dashboard"
  },
  "tools": [
    {
      "name": "my_tool",
      "description": "Does something useful",
      "timeout": 15000,
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
      "code_change_rules": { "action": "callback" },
      "custom_instructions": {
        "action": "append",
        "content": "This repo uses pnpm, not npm."
      }
    }
  },
  "subscribe": ["user.message", "assistant.message"],
  "context": "CI is currently passing. No active deploys."
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Provider identity |
| `session` | no | Session to bind to. Omit for internal providers (gateway auto-stamps). `"all"` for broadcast. |
| `instance` | no | Unique instance ID for multi-instance providers (e.g., browser tabs). Gateway uses `name` + `instance` as compound key. |
| `reconnectToken` | no | Token from previous `hello.ack` to restore binding after disconnect. |
| `startup_context` | no | Injected into session start context (not per-prompt). |
| `metadata` | no | Provider-specific info exposed to Copilot for routing decisions. |
| `tools` | no | Tool definitions with JSON Schema parameters. `timeout` (ms) per tool is optional. |
| `hooks` | no | Hook rules and transform declarations. |
| `subscribe` | no | Session event types to receive. External providers limited to tool events. |
| `context` | no | Ambient context injected on every user prompt. Not available for external providers. |

### `tool.result` — respond to a tool invocation

Success:
```json
{
  "type": "tool.result",
  "id": "call-123",
  "data": { "user": "alice", "role": "admin" }
}
```

Failure:
```json
{
  "type": "tool.result",
  "id": "call-123",
  "error": "Element not found: #submit-btn",
  "errorCode": "NOT_FOUND",
  "retryable": false
}
```

Error codes: `NOT_FOUND`, `TIMEOUT`, `CANCELLED`, `DISCONNECTED`, `UNAUTHORIZED`, `INTERNAL`. `retryable` hints whether the gateway should retry on another instance.

### `tool.progress` — incremental status for slow tools

```json
{
  "type": "tool.progress",
  "id": "call-123",
  "message": "Capturing viewport... 60%"
}
```

Gateway surfaces via `session.log()`. Final result still comes via `tool.result`.

### `gate.result` — respond to a hook gate check

```json
{
  "type": "gate.result",
  "gateId": "check-before-push",
  "callId": "gate-456",
  "decision": "deny",
  "reason": "CI is failing on this branch. Fix tests first."
}
```

`decision`: `"allow"` | `"deny"` | `"context"` (allow but inject `reason` as additional context).

### `transform.result` — respond to a transform callback

```json
{
  "type": "transform.result",
  "callId": "tx-789",
  "content": "...existing content plus dynamic additions based on live state..."
}
```

### `push` — send an event into the session

```json
{
  "type": "push",
  "stream": "ci-watch",
  "event": "CI failed on test/auth.spec.ts",
  "level": "inject",
  "metadata": { "kind": "ci-failure", "runId": 12345 }
}
```

| Field | Required | Description |
|---|---|---|
| `stream` | no | Named stream. Defaults to provider name if omitted. One provider can manage multiple streams. |
| `sessionId` | no | Target session. **Required** for `"all"`-bound providers (must specify a session or `"broadcast": true`). Single-session providers can always omit. |
| `event` | yes (unless `prompt`) | Event text to store/surface/inject. |
| `prompt` | no | When present, triggers a full AI turn via `session.send({ prompt })`. Use for PromptEmitter-style injections. |
| `level` | yes | `"inject"` = `session.send()`, triggers AI turn. `"surface"` = `session.log()`, visible in timeline. `"keep"` = store in EventStream only. |
| `metadata` | no | Structured data for display, deduplication, chaining. |

### `tools.update` — change tool definitions

```json
{
  "type": "tools.update",
  "sessionId": "abc123",
  "tools": [
    { "name": "new_tool", "description": "Just appeared", "parameters": {} }
  ],
  "remove": ["old_tool"]
}
```

`sessionId` is optional. Omit to apply to all bound sessions. `"all"`-bound providers use it to update tools in one session only.

### `hooks.update` — change hook rules or transforms

```json
{
  "type": "hooks.update",
  "sessionId": "abc123",
  "onPreToolUse": [
    {
      "match": { "tool": "edit", "file": "*.sql" },
      "action": "context",
      "content": "This is a migration file. Ensure backward compatibility."
    }
  ],
  "transforms": {
    "code_change_rules": { "action": "callback" },
    "custom_instructions": null
  }
}
```

Setting a transform to `null` removes it. `"callback"` triggers `transform.request` round-trips. `sessionId` is optional — omit to apply to all bound sessions.

### `context.update` — change ambient context

```json
{
  "type": "context.update",
  "context": "CI is now passing. Deploy v2.4.3 completed."
}
```

### `filter.set` — set gateway-side EventFilter for a stream

```json
{
  "type": "filter.set",
  "stream": "git-watch",
  "rules": [
    { "match": "behind=0", "outcome": "drop" },
    { "match": "conflicts=[1-9]", "outcome": "inject" },
    { "match": ".*", "outcome": "keep" }
  ]
}
```

When a filter exists, the gateway applies it to `push` events on that stream. The `level` field on `push` is overridden by the filter outcome. First-match wins.

### `stream.query` — read EventStream history

```json
{
  "type": "stream.query",
  "queryId": "q-1",
  "sessionId": "abc123",
  "streams": ["ci-watch@ci-watcher", "git-watch@guardian"],
  "last": 10
}
```

`sessionId` is optional for single-session providers, required for `"all"`-bound providers.

Stream names use the format `stream@provider` to avoid collisions. Omit `@provider` to query your own streams. Cross-provider reads require `streamAccess: "all"` in `hello`.

### `session.ready` — acknowledge readiness for a new session

```json
{
  "type": "session.ready",
  "sessionId": "new-session-id"
}
```

Only used by `"all"`-bound providers. When a new session starts, the gateway sends `sessions.updated` but does NOT register the provider's tools in the new session until `session.ready` is received. This gives the provider time to initialize session-specific state.

### `shutdown.ready` — async cleanup complete

```json
{
  "type": "shutdown.ready",
  "sessionId": "abc123"
}
```

Sent after `session.lifecycle: shutdown.pending`. Tells the gateway this provider is done cleaning up.

### `goodbye` — graceful disconnect

```json
{
  "type": "goodbye",
  "reason": "shutting down"
}
```

---

## Multi-instance providers (browser tabs)

When multiple providers share the same `name` (e.g., 5 browser tabs), the gateway:

1. Uses `name` + `instance` as the compound key
2. Registers **one** copy of each shared tool with an auto-injected `target` parameter
3. Generates a meta-tool `list_{name}_instances` from connected instances + metadata
4. Routes `tool.call` to the matching instance via `target`
5. If `target` is omitted, routes to the most recently active instance

```json
// Auto-generated tool schema (gateway creates this)
{
  "name": "browser_screenshot",
  "description": "Screenshot the viewport",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "description": "Tab instance ID. Available: tab-a3f8 (Dashboard — MyApp), tab-b2c1 (Settings)"
      }
    }
  }
}
```

```json
// Auto-generated meta-tool
{
  "name": "list_browser_instances",
  "description": "List connected browser tab instances",
  "handler": "returns instance IDs + metadata for all connected browser providers"
}
```

---

## Hook rules — declarative API

Providers declare rules, gateway evaluates them in-process.

### onPreToolUse rules

| Action | Behavior | Round-trip? |
|---|---|---|
| `"deny"` | Block the tool call with `reason` | No (static) |
| `"context"` | Allow but inject `content` as additional context | No (static) |
| `"gate"` | Ask the provider to evaluate via `gate.check`/`gate.result` | Yes (5s timeout) |

```json
{
  "match": { "tool": "shell", "args": "git push" },
  "action": "gate",
  "gateId": "check-ci-status"
}
```

`match.tool` is the tool name. `match.args` is a regex tested against stringified args. `match.provider` scopes to a specific provider's tools (omit for all tools).

### Transform rules

| Action | Behavior | Round-trip? |
|---|---|---|
| `"append"` | Append static `content` to section | No |
| `"prepend"` | Prepend static `content` to section | No |
| `"replace"` | Replace section with static `content` | No |
| `"callback"` | Ask provider at prompt time via `transform.request`/`transform.result` | Yes (2s timeout) |

Multiple providers can append to the same section. Gateway concatenates in registration order.

---

## Summary: the complete interface

### Gateway → Provider (13 message types)

| Message | When | Round-trip? |
|---|---|---|
| `auth.pairing` | After external provider requests pairing | Expects `auth.confirm` |
| `sessions` | After successful auth | — |
| `sessions.updated` | Session starts/ends | — |
| `hello.ack` | After `hello` (includes `providerId`, `protocolVersion`) | — |
| `ack` | After `tools.update`, `hooks.update`, `context.update`, `filter.set` | — |
| `error` | Invalid message from provider (includes `providerId`, `sessionId`) | — |
| `tool.call` | Copilot invokes a tool | Expects `tool.result` |
| `tool.cancel` | Tool timed out or session interrupted | — |
| `gate.check` | Hook rule matched with `action: "gate"` | Expects `gate.result` (5s, fail closed) |
| `transform.request` | Prompt submitted, provider has callback transform | Expects `transform.result` (2s) |
| `session.event` | Session event (if subscribed) | — |
| `session.lifecycle` | Session state change (includes `sessionId`) | — |
| `stream.history` | Response to `stream.query` | — |

### Provider → Gateway (18 message types)

| Message | When |
|---|---|
| `auth` | First message on connect (token or pairing mode) |
| `auth.confirm` | Confirm pairing code (external providers) |
| `hello` | After receiving `sessions` (includes `protocolVersion`) |
| `goodbye` | Graceful disconnect |
| `session.ready` | Acknowledge readiness for a new session (`"all"`-bound providers) |
| `tool.result` | Responding to `tool.call` |
| `tool.progress` | Incremental status for slow tools |
| `gate.result` | Responding to `gate.check` |
| `transform.result` | Responding to `transform.request` |
| `push` | Unsolicited event or prompt |
| `tools.update` | Add/remove tools |
| `hooks.update` | Change hook rules or transforms |
| `context.update` | Change ambient context |
| `filter.set` | Set/update EventFilter rules on a stream |
| `stream.query` | Read EventStream history |
| `shutdown.ready` | Async cleanup complete (includes `sessionId`) |

### Total: 31 message types

---

## What a minimal provider looks like

### Node.js — 50 lines

```js
import WebSocket from "ws";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const secret = process.env.TAP_GATEWAY_SECRET
  || readFileSync(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), ".tap-gateway-secret"), "utf8").trim();

const ws = new WebSocket("ws://localhost:9400");

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "auth", secret }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === "sessions") {
    ws.send(JSON.stringify({
      type: "hello",
      name: "hello-provider",
      session: msg.active[0]?.id ?? "all",
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
  }

  if (msg.type === "tool.call" && msg.tool === "say_hello") {
    ws.send(JSON.stringify({
      type: "tool.result",
      id: msg.id,
      data: `Hello, ${msg.args.name}!`
    }));
  }
});
```

### Browser — injected via Detour, with session picker and auth

```js
const GATEWAY = "localhost:9400";
let ws, sessions = [], registered = false, secret;
let reconnectToken = null;
const INSTANCE = "tab-" + Math.random().toString(36).slice(2, 6);

// Step 1: connect and request pairing
fetch(`http://${GATEWAY}/secret`)
  .catch(() => null);  // no secret endpoint anymore — we use pairing

function connect() {
  ws = new WebSocket(`ws://${GATEWAY}`);

  ws.onopen = () => {
    // Step 2: request pairing (user will see a code in Copilot)
    ws.send(JSON.stringify({ type: "auth", mode: "pair" }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    // Step 3: handle pairing
    if (msg.type === "auth.pairing") {
      showOverlay(`Pairing code: ${msg.code} — confirm in your Copilot session`);
      ws.send(JSON.stringify({ type: "auth.confirm", code: msg.code }));
      return;
    }

    // Step 4: receive session list or ack
    if (msg.type === "sessions" || msg.type === "sessions.updated") {
      sessions = msg.active;
      if (!registered) {
        if (sessions.length === 0) showOverlay("Waiting for Copilot session...");
        else if (sessions.length === 1) register(sessions[0].id);
        else showSessionPicker(sessions, (s) => register(s.id));
      }
      return;
    }

    if (msg.type === "hello.ack") {
      reconnectToken = msg.reconnectToken;  // persist for reconnect
      return;
    }

    if (msg.type === "tool.call") handleToolCall(msg);
    if (msg.type === "tool.cancel") handleCancel(msg);
  };

  ws.onclose = () => {
    registered = false;
    setTimeout(connect, 5000); // auto-reconnect
  };
}

function register(sessionId) {
  registered = true;
  ws.send(JSON.stringify({
    type: "hello",
    name: "browser",
    instance: INSTANCE,
    reconnectToken,  // restore binding on reconnect (null on first connect)
    session: sessionId,
    metadata: { url: location.href, title: document.title },
    tools: [
      { name: "page_title", description: "Get page title", parameters: {} },
      { name: "screenshot", description: "Screenshot viewport (downscaled to <5MB)", timeout: 15000, parameters: {} }
    ]
  }));
}

function handleToolCall(msg) {
  if (msg.tool === "page_title") {
    ws.send(JSON.stringify({ type: "tool.result", id: msg.id, data: document.title }));
  }
  if (msg.tool === "screenshot") {
    ws.send(JSON.stringify({ type: "tool.progress", id: msg.id, message: "Capturing..." }));
    html2canvas(document.body, { scale: 0.5 }).then(canvas => {
      ws.send(JSON.stringify({
        type: "tool.result", id: msg.id,
        data: { image: canvas.toDataURL("image/jpeg", 0.7) }
      }));
    });
  }
}

function handleCancel(msg) {
  // Best-effort: send CANCELLED result
  ws.send(JSON.stringify({
    type: "tool.result", id: msg.id,
    error: "Cancelled", errorCode: "CANCELLED", retryable: false
  }));
}
```

### Python — 35 lines

```python
import asyncio, json, websockets

async def provider():
    async with websockets.connect("ws://localhost:9400") as ws:
        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "sessions":
                await ws.send(json.dumps({
                    "type": "hello",
                    "name": "python-provider",
                    "session": msg["active"][0]["id"] if msg["active"] else "all",
                    "tools": [{
                        "name": "compute",
                        "description": "Evaluate a Python expression",
                        "parameters": {
                            "type": "object",
                            "properties": {"expr": {"type": "string"}},
                            "required": ["expr"]
                        }
                    }]
                }))

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
