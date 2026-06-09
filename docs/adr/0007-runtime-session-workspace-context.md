# ADR 0007: Runtime session workspace context boundary

## Status

Accepted

## Context

No `docs/adr/0000-template.md` exists, so this ADR follows the existing ADR
style.

Runtime services previously shared the active session workspace through loose
getter/setter cwd closures. That made the mutable cwd boundary easy to
thread through services but left ownership split across runtime subsystem
bootstrap, config loading, emitter service fallback behavior, and supervisor cwd
validation.

ADR 0004 requires persistent config loading to be transactional: failed loads
must not replace the last-known-good config state. ADR 0006 requires
command-emitter `cwd` values to remain relative to the session workspace and to
be validated by the existing workspace-boundary rules. Those decisions remain
the source of truth for config safety and emitter cwd semantics; this ADR records
where the runtime owns the shared session/workspace context.

## Decision

- Introduce a runtime-owned session/workspace context for active session
  identity metadata, current session/base cwd, current config cwd, and emitter
  cwd resolution.
- Runtime subsystem construction creates or receives this context once and then
  hands out narrow capability views:
  - config bootstrap receives config cwd resolution/commit capabilities;
  - emitter services and supervisor receive emitter cwd resolution capabilities.
- Config bootstrap resolves the candidate cwd before loading config, then
  commits the runtime context's base/config cwd only after `configStore.load()`
  succeeds or completes the no-config-found path. This keeps runtime cwd
  ownership aligned with ADR 0004 last-known-good load semantics.
- Emitter cwd resolution remains delegated to the existing path validation
  helpers, preserving ADR 0006 behavior:
  - omitted, blank, or `.` emitter `cwd` uses the session cwd;
  - subdirectories under the session cwd are allowed;
  - absolute paths and traversal outside the session cwd are rejected;
  - this remains cwd placement hardening, not a shell sandbox.
- Emitter start fallback preserves the prior nullish-only base cwd behavior:
  omitted/null base cwd options use the current session cwd, while explicitly
  supplied base cwd values are normalized as supplied.
- Public tool names, provider protocol behavior, emitter delivery semantics,
  persistence defaults, and config canonicalization rules are unchanged.

## Consequences

- The mutable session/workspace boundary has one owner instead of ad hoc closure
  plumbing across services.
- Dependency injection remains capability-specific: consumers receive config or
  emitter workspace capabilities rather than a broad runtime object.
- Failed config loads cannot advance the runtime context's config/base cwd ahead
  of the last-known-good config load state.
- Command-emitter cwd validation remains centralized on the existing helper and
  keeps the ADR 0006 workspace-relative contract.
- Future changes to runtime session/workspace ownership, config cwd commit
  timing, base cwd fallback semantics, or emitter cwd validation ownership
  should update or supersede this ADR.
