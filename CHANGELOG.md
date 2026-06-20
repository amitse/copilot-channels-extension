# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added structured emitter-run traces to diagnostics snapshots and the
  diagnostics canvas.
- Added read-only `tap_get_session_state` for mode/model/tasks/schedules/canvas
  awareness.
- Added `tap_verify_goal_output` and `tap_audit_claims` evidence tools.
- Added `/tap-orchestrate` as a foundation for coordinator and role-emitter
  workflows.
- Added provider integration and control-plane roadmap recipes.

### Changed

- Strengthened `/tap-goal` with Codex-style goal contracts: outcome,
  verification surface, constraints, boundaries, iteration policy, and blocked
  stop condition.
- `/tap-goal` now chooses timed backoff PromptEmitters for autopilot-compatible
  goals while keeping idle PromptEmitters for conservative continuation.
- Goal-loop prompts now require evidence audits, structured EventStream
  iteration records, research claim ledgers, and budget-limited handoffs.
- Timed prompt deferrals caused by busy sessions no longer consume `maxRuns`
  budget.
- `/tap-monitor` companion prompts now post structured REVIEW RECORD audit
  entries.
- Evals can include rubrics, required/prohibited observations, deterministic
  assertions, and pass/fail examples in judge prompts.

## [2.0.1] — 2026-05-06

### Added

- Added the namespaced `/tap-goal` skill for autonomous goal loops powered by
  idle PromptEmitters with explicit iteration budgets and budget-aware
  wrap-up steering.

### Changed

- Default `/tap-goal` iteration budget is 50.
- Clarified that `/tap-goal` is idle-driven and that always-busy autopilot
  flows are better served by timed prompts or hook/session-injector delivery.

## [2.0.0] — 2026-04-29

### Changed — **BREAKING**

- Skills are now namespaced under the `tap-` prefix to avoid conflicts with
  other Copilot skills that use generic names like `loop` or `monitor`:

  | Old invocation       | New invocation           |
  | -------------------- | ------------------------ |
  | `/loop`              | `/tap-loop`              |
  | `/monitor`           | `/tap-monitor`           |
  | `/create-provider`   | `/tap-create-provider`   |

  Installed skill directories change accordingly:

  | Old path                       | New path                           |
  | ------------------------------ | ---------------------------------- |
  | `skills/loop/SKILL.md`         | `skills/tap-loop/SKILL.md`         |
  | `skills/monitor/SKILL.md`      | `skills/tap-monitor/SKILL.md`      |
  | `skills/create-provider/SKILL.md` | `skills/tap-create-provider/SKILL.md` |

  **Migration:** Run `npx copilot-tap-extension` — the installer automatically
  removes the old deprecated skill files and installs the new namespaced ones.
  No manual cleanup required.

### Fixed

- Updates via `npx copilot-tap-extension` now install new skill files that
  don't yet exist at the target location. Previously, only the core extension
  bundle was updated, causing newly shipped skills to be silently skipped.

- `npx copilot-tap-extension --force` is now the documented full reinstall path.
  The installer still accepts `--full` as a legacy alias, but `--force` is the
  single documented forceful behavior.

- Forced reinstalls now remove deprecated pre-2.0.0 skill files before reporting
  success, so legacy `/loop`, `/monitor`, and `/create-provider` commands do not
  survive a reinstall.

## [1.1.4] — 2026-04-28

### Fixed

- Resolved packaging issue that prevented the `monitor` skill from being
  included in the published npm bundle.

## [1.1.2] — prior release

- Initial public release with `/loop`, `/monitor`, and `/create-provider` skills.

[Unreleased]: https://github.com/amitse/copilot-tap-extension/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/amitse/copilot-tap-extension/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/amitse/copilot-tap-extension/compare/v1.1.4...v2.0.0
[1.1.4]: https://github.com/amitse/copilot-tap-extension/compare/v1.1.2...v1.1.4
[1.1.2]: https://github.com/amitse/copilot-tap-extension/releases/tag/v1.1.2
