# Tap provider templates

These templates are intentionally dependency-free starting points for external
providers. They normalize events and tool shapes; real credentials and API calls
belong in environment-specific adapters.

Each template follows the same contract:

1. Read provider token from `TAP_PROVIDER_TOKEN` or the tap token file.
2. Connect to `ws://127.0.0.1:9400`.
3. Authenticate and declare tools.
4. Emit normalized event JSON suitable for EventFilter rules.

Templates:

- `ci-review-provider.mjs` — structured code review findings.
- `jira-github-provider.mjs` — Jira issue and GitHub PR handoff shape.
- `sast-triage-provider.mjs` — security finding triage and fingerprinting.
- `detour-workflow-provider.mjs` — browser/Detour event normalization.

These are not production integrations by themselves. They are safe scaffolds for
turning CI, issue trackers, SAST scanners, and browser instrumentation into tap
provider workflows.
