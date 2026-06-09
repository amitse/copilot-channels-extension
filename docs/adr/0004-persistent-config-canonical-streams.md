# ADR 0004: Persistent config stream injector and alias semantics

## Status

Accepted

## Context

No `docs/adr/0000-template.md` exists, so this ADR follows the existing ADR style.

ADR 0001 records that persisted emitter definitions default to user-owned,
persistent ownership semantics. Persistent stream definitions have the same
on-disk/user-authored character, but session-injector normalization defaulted
missing ownership and lifespan to model-owned, temporary values while runtime
bootstrap applied persisted streams as user-owned, persistent definitions.

Emitter config also has two names for the destination EventStream:

- `stream` is the documented config field.
- `channel` is a legacy alias still accepted by older tools and config files.

Keeping both fields in normalized/serialized config lets a stale `channel`
silently override an edited `stream` in runtime paths that consume only
`channel`.

## Decision

- Persisted stream `sessionInjector` entries default to:
  - `ownership: "userOwned"`
  - `lifespan: "persistent"`
- Explicit compatibility fields are still honored:
  - `ownership` or legacy `managedBy`
  - `lifespan` or legacy `scope`
- `stream` is the canonical persisted emitter destination field.
- `channel` remains accepted as an input alias for backwards compatibility.
- When both `stream` and `channel` are present and conflict, `stream` wins.
- Normalization and serialization drop the legacy `channel` alias after resolving
  the canonical `stream`, preventing stale aliases from being persisted again.
- Runtime emitter normalization and configured-emitter projection prefer
  `stream` over `channel` so user-authored config and runtime routing agree.
- Config migration persistence is best-effort: loading a readable config should
  succeed even if saving the canonical migrated form fails. The store should skip
  the migration save when the parsed on-disk JSON is already canonically equal.
- Config loading is transactional. The store builds candidate cwd/path/config
  state in locals and commits it only after read, parse, and migration all
  succeed, or after the config search completes successfully with no file found.
  If a load fails, the previous runtime config remains active and subsequent
  saves are refused until a later load succeeds.
- Persisted stream entries must include an explicit, non-blank string `name`.
  `name: "main"` remains valid, but missing, blank, non-string, or otherwise
  non-normalizable names are config validation errors and are never defaulted to
  `main`.
- A persisted stream entry with only metadata such as `name` and `description`
  does not define durable SessionInjector policy. Applying such an entry keeps
  the runtime injector on the non-protected default
  (`modelOwned`/`temporary`, disabled) instead of synthesizing a
  `userOwned`/`persistent` injector. Only an explicit `sessionInjector` or
  legacy `subscription` object receives the persisted stream injector defaults
  above.
- Bootstrap auto-start of emitter definitions already present in config is a
  runtime restoration path, not a durable config update. It must not require a
  config rewrite when no persisted emitter or stream policy is being changed.

## Consequences

- Hand-authored stream injector config aligns with runtime persistent semantics
  and the user-owned defaults documented for durable workflows.
- Existing channel-only config remains valid and is migrated to `stream`.
- Editing `stream` is deterministic even if an old `channel` field remains.
- Read-only or temporarily unwritable config files no longer prevent the
  extension from using an otherwise valid config; users receive a warning when
  canonical migration persistence fails.
- Malformed or unreadable config files cannot replace the last known-good
  runtime config and cannot be overwritten later by an empty or partially loaded
  state via `save()`.
- Malformed persisted stream entries fail config normalization instead of
  silently enabling or modifying the default `main` stream.
- Bare persisted stream entries preserve stream metadata without turning normal
  unforced SessionInjector updates into protected user-owned mutations.
- Auto-start restoration can recover already-persisted emitters from a
  read-only config file, while user-initiated durable emitter starts and stream
  injector changes still persist and roll back on save failure.
- Future changes to persistent config defaults, stream-name validation, emitter
  destination aliases, transactional load/save safety, bootstrap restoration
  writes, or migration write-failure behavior should update or supersede this
  ADR.
