# ADR 0005: Bound-provider SDK push and dynamic tools

## Status

Accepted

## Context

No `docs/adr/0000-template.md` exists, so this ADR follows the existing ADR style.

The provider SDK exposes `push`, `surface`, `keep`, and `updateTools`. Detour already calls `provider.push()`. Before this decision, the gateway accepted only `auth`, `hello`, `tool.result`, and `goodbye` from providers after binding, so SDK pushes and dynamic tool updates were rejected as unknown message types.

The full provider-interface design contains broader advanced-provider features such as hooks updates, context updates, stream queries, subscriptions, all-session binding, pairing auth, revisions, and update acknowledgments. Those features are intentionally outside this follow-up.

## Decision

- A provider must still authenticate and send `hello` for exactly one active session before using the new messages.
- While Bound, a provider may send `push` with:
  - `level`: `keep`, `surface`, or `inject`
  - `event`: non-empty text
  - optional `stream`, defaulting in the SDK to the provider name
  - optional `sessionId`, which must match the session selected in `hello`
  - optional object `metadata`
- Explicit push stream names use the same canonical EventStream identifier rules as stream tools. The gateway rejects non-normalizable stream names instead of falling back to `main`; accepted pushes use the canonical stream name consistently for storage, notifications, and return values. If a push omits `stream`, the runtime uses the canonical provider name/id when possible and otherwise falls back to `main`.
- Push delivery is immediate and session-bound:
  - `keep` appends to the EventStream only.
  - `surface` appends and logs to the Copilot timeline.
  - `inject` appends, logs, and enqueues a session injection through the existing retrying notification dispatcher.
- Provider push delivery uses the shared stream delivery policy seam in provider-authoritative mode. The provider-selected `level` remains the complete delivery policy for that push: provider `inject` is not gated by the destination stream's SessionInjector, and provider `keep`/`surface` semantics are unchanged.
- Provider push surfacing is best-effort: timeline logging failures must not create unhandled promise rejections or prevent the already-appended stream event from remaining stored.
- While Bound, a provider may send `tools.update` with a complete replacement `tools` array using the same validation and 100-tool cap as `hello.tools`.
- `tools.update` is accepted only for the bound session. A supplied `sessionId` must match the session selected in `hello`.
- Successful `tools.update` replaces the provider's registry entry, updates the connection's active tool definitions, and schedules the same debounced session tool refresh used by provider connect/disconnect.
- Rejected `tools.update` messages leave the previous provider tool list active.
- Existing in-flight tool calls are not cancelled when a successful update removes their tool definition; they continue to their result, timeout, cancellation, or disconnect outcome.
- `hello.ack` may include `sessionId` so SDK providers can observe the bound session.
- This minimal contract does not add hooks updates, context updates, stream queries, subscriptions, all-session binding, pairing auth, per-update revisions, or success acknowledgments.

## Consequences

- SDK providers can use `provider.push()`, `provider.surface()`, `provider.keep()`, and `provider.updateTools()` without being rejected by the gateway.
- Detour page messages can reach the Copilot session instead of failing as unknown provider messages.
- The shared delivery seam records the provider delivery matrix alongside CommandEmitter delivery policy while preserving this ADR's existing `keep`/`surface`/`inject` behavior.
- Invalid provider-selected stream names fail closed instead of silently misrouting events into `main`.
- Dynamic tools remain simple and deterministic: each update replaces the provider's complete tool list and reuses the existing reload path.
- Providers do not receive a success ack for `tools.update`; they should treat absence of `error` as success in the minimal profile.
- The gateway remains single-session-bound for external providers, preserving the current security boundary.
- Future changes to provider push semantics, dynamic tool update acknowledgments/revisions, multi-session binding, pairing auth, or advanced provider capabilities should update or supersede this ADR.
