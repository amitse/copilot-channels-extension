# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added the namespaced `/tap-goal` skill for Codex-style autonomous goal loops
  powered by idle PromptEmitters with explicit iteration budgets.

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

[Unreleased]: https://github.com/amitse/copilot-tap-extension/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/amitse/copilot-tap-extension/compare/v1.1.4...v2.0.0
[1.1.4]: https://github.com/amitse/copilot-tap-extension/compare/v1.1.2...v1.1.4
[1.1.2]: https://github.com/amitse/copilot-tap-extension/releases/tag/v1.1.2
