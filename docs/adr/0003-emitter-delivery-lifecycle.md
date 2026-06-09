# ADR 0003: Emitter delivery lifecycle is retryable and transactional

## Status

Accepted

## Context

No `docs/adr/0000-template.md` exists, so this ADR follows the existing ADR style.

Persistent emitter auto-start, stream session-injector policy, notification delivery, and supervisor persistence happen across separate modules. A persistent emitter may produce output during session startup, before the Copilot session is attached to the cached runtime, and it may route `surface` or `inject` outcomes through the stream's session injector immediately.

The lifecycle contract needs to avoid these failure modes:

- auto-started persistent emitters must not silently suppress `surface`/`inject` outcomes when no explicit stream injector is configured;
- queued notification delivery must not discard a batch solely because the session is not attached yet;
- a failed persistent start must not report failure while leaving a newly-started emitter running outside durable config.
- startup surface logs must not disappear when emitters produce `surface` output before the Copilot session object is attached to the cached runtime.
- session shutdown cleanup must not report completion before child processes close, except through a bounded timeout path.
- idle PromptEmitters auto-started during session startup must not remain `WAITING` forever solely because the initial `session.idle` transition happened before the runtime's session activity bridge was attached.

## Decision

- Config bootstrap preserves explicit `subscribe: false` on emitter definitions.
- When a persistent stream already has a configured session injector, auto-start does not overwrite that injector during emitter start; the persisted stream policy remains authoritative.
- When no explicit stream injector is configured for the emitter stream, bootstrap allows the emitter's normal subscription default to apply so `surface`/`inject` filter outcomes have an enabled delivery path.
- Notification dispatch removes a batch from the queue only for an attempted send, and requeues that batch at the front when delivery fails because the session is not attached. Retry is delayed and single-flight to avoid tight retry loops while preserving notification ordering. The retry queue is bounded in memory: new updates are dropped when the queue is full, and retry requeues preserve the failed batch at the front while dropping any overflow from the tail. Drops are reported through session diagnostics.
- Session end/shutdown advances the notification dispatch generation, cancels pending retry timers, and clears queued-but-unsent notifications so stale background updates from one Copilot session cannot be injected into a later session.
- Session timeline logs emitted before initial attach are queued in bounded memory by the session port and replayed after attach. This covers startup `surface` delivery races without changing post-attach logging behavior.
- Supervisor start is transactional around newly-started emitters: if post-start persistence fails, the supervisor requests a bounded stop-and-wait for the new emitter, removes/restores the in-memory emitter entry after the stop settles, restores the prior session-injector state, and best-effort restores the previous persistent emitter config before surfacing the failure. If the bounded rollback wait times out or stop fails, the runtime emitter entry and current injector state remain visible for manual cleanup while durable config is still restored best-effort.
- Bootstrap restoration of an emitter that already exists in persistent config is
  a runtime-only start path. When bootstrap does not request any durable
  mutation, supervisor start skips config rewrites and persistence rollback so a
  read-only or temporarily unwritable config file cannot by itself prevent
  auto-start recovery. User-initiated persistent starts and persistent injector
  updates continue to use the transactional persistence behavior above.
- Scheduled emitter iterations must clear `inFlight` in a `finally` path and convert unexpected thrown/rejected iteration failures into deterministic failed iteration results so unhandled rejections cannot strand an emitter in `RUNNING`.
- Ordinary emitter `stop()` remains a request/transition operation for tool compatibility. Shutdown uses a separate wait path that requests stop, waits for child `close`/in-flight completion, and returns per-emitter outcomes (`stopped`, `timedOut`, or `failed`) instead of discarding timeout/rejection details. Hook cleanup summaries report those outcomes rather than claiming unconditional success.
- After session listeners are attached, the runtime synthesizes one initial idle lifecycle nudge by marking the session port idle and calling the supervisor's existing `onSessionIdle()` path. Later real activity events clear scheduled idle work through the normal session-activity transition. This gives persistent idle PromptEmitters auto-started during `onSessionStart` a deterministic first scheduling path even when the SDK does not replay an already-observed `session.idle` event to late listeners.
- CommandEmitter event delivery is resolved through the shared stream delivery policy seam, preserving the existing EventFilter + SessionInjector matrix:
  - `drop` stores nothing and increments the dropped-line count.
  - `keep` stores the event and surfaces it only when the stream SessionInjector is enabled with `delivery: "all"`.
  - `surface` stores the event and surfaces it only when the stream SessionInjector is enabled with `delivery: "surface"` or `delivery: "all"`.
  - `inject` stores the event and enqueues session injection when the stream SessionInjector is enabled with `delivery: "important"`, `"all"`, `"surface"`, or `"inject"`; it surfaces only for enabled `delivery: "surface"` or `"all"`.
  - Nullish SessionInjector delivery continues to default to `surface`; disabled SessionInjectors and `keep`/`drop`/unknown non-null delivery modes do not proactively surface or inject.
- System notifications emitted by the line router continue to use the same SessionInjector injection decision for enqueueing, but they are not timeline-surfaced by that path.
- `handlePromptResult()` remains append-only compatibility code; this decision does not introduce PromptEmitter assistant-response capture.

## Consequences

- Persistent emitters with `inject` or `surface` event-filter outcomes can deliver immediately after auto-start without requiring a duplicate stream entry.
- User-configured persistent stream injector policy remains the source of truth when both a stream definition and an emitter definition exist.
- Session startup races defer notification delivery instead of losing background events.
- Startup surface events can appear after attach instead of being silently suppressed by a temporarily detached session port.
- Startup idle PromptEmitters can run after attach without waiting for a second idle transition; if real session activity follows attach, the existing activity bridge cancels the pending idle timer.
- Retried notifications retain FIFO order relative to later queued updates that remain inside the bounded retry queue; deterministic overflow drops prefer preserving older/retried work over newer tail entries.
- Session lifecycle clearing prevents queued notification retries from crossing session boundaries.
- A caller that sees persistent emitter start fail should not also have a hidden running emitter to clean up; if rollback cannot confirm settlement before the bounded timeout, the emitter remains visible in runtime state for manual cleanup.
- Persistent emitter auto-start from config can succeed even when the existing
  config file cannot be rewritten, provided no durable state change was
  requested by bootstrap.
- Shutdown cleanup can wait for real process closure without changing the public meaning of user/tool stop requests, and session summaries can distinguish emitters that stopped, timed out, or failed during cleanup.
- The shared delivery seam centralizes CommandEmitter delivery decisions without changing EventFilter outcomes, SessionInjector authority, notification retry behavior, or PromptEmitter capture semantics.
- Future changes to auto-start subscription defaults, bootstrap persistence
  writes, notification/log replay policy, attach-time idle nudging, scheduled
  iteration failure handling, notification retry bounds/session clearing,
  shutdown wait reporting behavior, or supervisor start rollback semantics
  should update or supersede this ADR.
