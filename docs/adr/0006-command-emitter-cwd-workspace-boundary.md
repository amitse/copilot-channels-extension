# ADR 0006: Command-emitter cwd stays within the session workspace

## Status

Accepted

## Context

No `docs/adr/0000-template.md` exists, so this ADR follows the existing ADR style.

Command emitters accept an optional `cwd` field so a watcher can run from a
subdirectory such as `services/api`. Before this decision, `cwd` resolution used
`path.resolve(sessionCwd, requestedCwd)`, which also accepted absolute paths and
relative traversal that escaped the Copilot session working directory.

That behavior made a model-supplied emitter request capable of changing the
process working directory outside the workspace boundary selected for the
session. ADR 0001 and ADR 0004 cover persistent ownership/config defaults, and
ADR 0002 covers provider gateway security; they do not define command-emitter
working-directory boundaries.

## Decision

- Command-emitter `cwd` is interpreted as a path relative to the session cwd.
- Omitted or blank `cwd` uses the session cwd.
- `cwd: "."` is allowed and resolves to the session cwd.
- Subdirectories under the session cwd are allowed.
- Absolute `cwd` values are rejected.
- Relative paths that resolve outside the session cwd, including `..` traversal,
  are rejected.
- This is API hardening for emitter configuration. It is not a shell sandbox:
  the spawned command still runs with the user's normal OS permissions, and the
  command itself may access files or change directories according to those
  permissions.

## Consequences

- Tool callers and persisted configs must express command-emitter working
  directories as workspace-relative paths.
- Existing configs that used absolute paths or traversal outside the session cwd
  will fail validation during auto-start until rewritten as in-workspace
  relative paths.
- The session cwd remains the durable boundary for command-emitter placement,
  reducing accidental or model-initiated execution from unrelated directories.
- Future changes to command-emitter cwd resolution, workspace-boundary behavior,
  or stronger process sandboxing should update or supersede this ADR.
