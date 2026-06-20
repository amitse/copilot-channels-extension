# Provider integration patterns

These recipes turn external workflow systems into tap-operable signals and tools.
They are intentionally provider-shaped: each integration exposes a small local
service or WebSocket provider, then tap uses EventStreams, EventFilters, goals,
and diagnostics to keep the agent connected to the workflow.

## Shared shape

1. Provider authenticates to the external system.
2. Provider registers focused tools through the tap provider gateway.
3. Provider exposes or emits normalized events with stable fields.
4. tap filters events into `keep`, `surface`, or `inject`.
5. High-value events can start or steer a `/tap-goal` or `/tap-orchestrate`
   workflow.

Prefer structured JSON lines for provider output:

```json
{"type":"ci.failure","repo":"owner/name","runUrl":"...","branch":"main","severity":"high"}
```

This makes EventFilter rules stable and auditable.

## Jira + GitHub

Inspired by the Codex Jira/GitHub automation pattern:

- Jira label or automation rule triggers a provider event.
- Provider tools:
  - `jira_get_issue`
  - `jira_transition_issue`
  - `jira_post_comment`
  - `github_create_pr`
- A goal completes only when the EventStream ledger includes:
  - Jira issue key
  - branch name
  - commit SHA
  - PR URL
  - Jira status transition

## CI auto-fix

Inspired by the Codex GitHub Actions auto-fix pattern:

- CommandEmitter or provider watches failed workflow runs.
- Failure events surface or inject with run URL and failing job.
- A repair goal uses the failing output as the verification surface.
- Completion requires a successful verification command and a traceable branch
  or PR.

## Code review

Inspired by the Codex SDK code-review pattern:

- Provider or skill runs a structured review command.
- Findings use stable fields:
  - title
  - body
  - confidence score
  - priority
  - file path
  - line range
- P0/P1 findings should inject; P2/P3 findings should surface or keep.

## SAST triage

Inspired by the GitLab security-quality pattern:

- Ingest SAST JSON as structured provider events.
- Deduplicate by `(CWE, sink/function, file:line)`.
- Rank by exploitability and business risk.
- Process one finding per goal iteration.
- Completion requires either a validated patch or an explicit blocked reason.

## Browser / Detour workflows

Use Detour for browser-page instrumentation and tap for agent-side orchestration:

- Detour injects browser bridge code.
- Provider exposes a local API for page events.
- CommandEmitter polls the provider and normalizes events.
- tap goals or monitors react to stable event types.

Do not mutate Detour source for tap-specific workflows; use injectable scripts
and provider-side adapters.
