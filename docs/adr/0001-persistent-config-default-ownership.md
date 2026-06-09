# ADR 0001: Persistent config emitters default to user ownership

## Status

Accepted

## Context

No `docs/adr/0000-template.md` existed when this ADR was written, so this file uses the standard ADR sections.

The project documentation treats on-disk emitter definitions as persistent workflows and recommends `userOwned` ownership for persistent, recurring, or policy-bearing emitters. Existing normalization code defaulted missing persisted emitter ownership and lifespan to `modelOwned` and `temporary`, even though configured emitters are restored from disk and listed as persistent definitions.

That mismatch can weaken the protection model for manually edited config files: an emitter with no explicit ownership may be treated as model-owned during normalization even though it came from persistent user config.

## Decision

Persisted/on-disk emitter definitions default to:

- `ownership: "userOwned"`
- `lifespan: "persistent"`

Normalization still honors explicit compatibility fields:

- `ownership` or legacy `managedBy`, including explicit `modelOwned`
- `lifespan` or legacy `scope`, including explicit `temporary`

Runtime-created temporary/model-owned emitters keep their explicit normalized fields when serialized, so this default only applies when persisted config omits ownership/lifespan signals.

## Consequences

- Manually authored config aligns with the documented safety default for persistent workflows.
- Legacy config with explicit `modelOwned` or `temporary` remains compatible.
- Future changes that alter config ownership/lifespan defaults should update or supersede this ADR.
