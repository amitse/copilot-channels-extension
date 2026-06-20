# Tap control-plane roadmap

This document records the implementation slices that connect the Codex/Copilot
extensibility audit to concrete tap capabilities.

## Implemented in this release slice

- **Emitter-run traces**: diagnostics now retain structured trace records for
  scheduled emitter runs, including trace id, emitter id, run index, duration,
  status, and error.
- **Diagnostics control tower foundation**: the diagnostics canvas now surfaces
  trace counts, recent emitter-run traces, and goal EventStream ledgers.
- **Goal evidence tools**: `tap_verify_goal_output` and `tap_audit_claims`
  verify workspace files, EventStream contents, and caller-supplied command
  evidence without secretly executing commands.
- **Mode-aware session state**: `tap_get_session_state` reads current mode,
  model, tasks, schedules, canvases, and UI capabilities without mutating the
  session.
- **Eval metadata hooks**: eval cases can now declare required observations,
  prohibited claims, rubrics, deterministic assertions, and pass/fail examples;
  the judge prompt consumes those fields when present.
- **Monitor audit trail**: `/tap-monitor` companion prompts now write structured
  REVIEW RECORD entries.
- **Orchestration foundation**: `/tap-orchestrate` defines the coordinator and
  role-emitter pattern for gated multi-agent workflows.
- **Provider recipe set**: reusable patterns now cover Jira/GitHub, CI auto-fix,
  code review, SAST triage, and browser/Detour workflows.

## Deferred deeper work

- **Full trace span hierarchy**: current traces are run-level records. A future
  slice should add child spans for line routing, provider calls, tool calls, and
  prompt dispatch using W3C `traceparent` where available.
- **Session FS/SQLite ledgers**: current goal/eval ledgers remain EventStream and
  JSON-tool based. A future slice should persist structured ledgers in Session
  FS/SQLite for queryable long-horizon work.
- **HALO-style optimizer**: eval metadata is now accepted, but the ranked
  recommendation handoff still needs an `evals/optimize` command.
- **Mode mutation policy**: mode state is read-only in this release. Future work
  can add guarded mode-setting tools backed by elicitation and ownership policy.
- **Goal timeline graph**: the canvas has trace and goal panels, but not a
  timeline graph or per-span drilldown yet.
- **Production provider examples**: recipes are documented; full provider
  implementations for Jira/GitHub and CI review remain future work.

## Validation expectation

Every control-plane slice should prove:

1. Runtime behavior has focused tests.
2. Tool surfaces have schema/handler tests.
3. Docs name the evidence surface and safety constraints.
4. Diagnostics expose the new state.
5. Smoke evals still show tap tools available.
