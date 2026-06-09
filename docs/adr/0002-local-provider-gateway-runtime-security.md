# ADR 0002: Local provider gateway token and runtime shutdown boundary

## Status

Accepted

## Context

No `docs/adr/0000-template.md` exists, so this ADR follows the existing ADR style.

The provider gateway lets local external processes register tools with a Copilot session over WebSocket. That boundary needs safe defaults for network exposure, token discovery, token lifetime, and shutdown cleanup. ADR 0001 covers persisted emitter ownership defaults and does not cover provider gateway security or runtime lifecycle. The extension entrypoint should not own provider protocol details; it delegates session lifecycle handling to the runtime facade.

Providers may be launched from the active Copilot environment, from a sibling terminal, or via the provider SDK. Sibling processes cannot reliably inherit `TAP_PROVIDER_TOKEN`, so the gateway needs a local discovery path without turning the token into durable configuration.

## Decision

- The provider WebSocket gateway binds to loopback by default: `127.0.0.1:9400`. Any non-loopback host must be an explicit runtime override.
- On gateway start, generate a fresh provider token for the running gateway instance.
- Publish the token in both supported discovery locations:
  - `TAP_PROVIDER_TOKEN` in the gateway process environment.
  - `<COPILOT_HOME or ~/.copilot>/extensions/tap/.provider-token` for sibling local providers and SDK auto-discovery.
- Create the token directory with restrictive permissions (`0700`) and write the token file with restrictive permissions (`0600`), including a best-effort chmod after write.
- Treat the token file as runtime state, not config: remove it and clear `TAP_PROVIDER_TOKEN` when the gateway stops.
- On session shutdown, the runtime facade owns provider lifecycle coordination. Entrypoints delegate shutdown listener registration to the cached runtime, which de-duplicates the effective `session.shutdown` handler across extension reloads and logs cleanup failures instead of allowing fire-and-forget rejections. The runtime sends `session.lifecycle` with `state: "shutdown.pending"` and a runtime-owned deadline (currently 10 seconds). Stop accepting new gateway connections immediately, but keep existing provider sockets open until they send `goodbye`, all sockets drain, or the deadline expires. After the deadline, close remaining provider sockets.
- Runtime session-shutdown cleanup uses the shutdown-specific emitter wait path from ADR 0003 before reporting cleanup complete; ordinary user/tool stop requests remain non-blocking stop requests.
- Bound-provider protocol failures that can represent an in-flight tool call's terminal response must fail deterministically. If a malformed message, oversized message, invalid `tool.result`, or syntactically valid `tool.result` with an unknown call id cannot be correlated while provider calls are pending, reject exactly one pending call with the protocol/validation error. If multiple calls are pending and correlation is impossible, disconnect the provider and reject all pending calls with `DISCONNECTED`. Unknown-id `tool.result` messages are protocol errors and are not delivered to normal tool-result callbacks.

## Consequences

- Local providers can connect from sibling terminals without manually copying environment variables, while the gateway remains limited to loopback by default.
- Token exposure is scoped to the current OS user profile and gateway runtime. The token is still bearer auth, so users must not share it or expose the token file to untrusted processes.
- Gateway stop acts as token revocation by deleting the token file and clearing the environment value.
- Providers get a bounded cleanup window during session shutdown, avoiding abrupt termination when they respond promptly and preventing indefinite shutdown hangs when they do not.
- Repeated extension reloads do not accumulate active shutdown cleanup handlers against the cached runtime, and rejected async shutdown cleanup is visible in stderr/session diagnostics.
- Invalid or uncorrelatable terminal provider behavior cannot leave Copilot-facing tool promises pending indefinitely, including tools without declared timeouts. Some parse/payload errors remain non-fatal when no calls are pending, but become fail-fast while ambiguous in-flight calls could otherwise be orphaned.
- Future changes to provider token discovery, host binding, token persistence, runtime shutdown ownership/deadlines/listener ownership, or pending-call fail-fast semantics should update or supersede this ADR.
