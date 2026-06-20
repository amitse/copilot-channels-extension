# Codex Goals lessons for `/tap-goal`

This recipe records the design lessons borrowed from OpenAI's
[Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
guide and maps them to ※ tap's `/tap-goal` skill.

## Core lesson

A goal is a **completion contract** attached to the current thread:

```text
work -> check evidence -> continue, complete, or stop blocked
```

It is not open-ended background autonomy. The objective persists, but evidence
decides whether work is complete.

## Strong goal contract

Before starting a goal loop, make these fields explicit:

| Field | Purpose |
| --- | --- |
| Outcome | Desired end state |
| Verification surface | Test, benchmark, command output, artifact, source material, or report that proves completion |
| Constraints | What must not regress |
| Boundaries | Files, tools, data, repositories, or resources in scope |
| Iteration policy | How to choose the next experiment/action after each attempt |
| Blocked stop condition | When to stop, what to report, and what would unlock progress |

Weak:

```text
/tap-goal improve performance
```

Strong:

```text
/tap-goal Reduce p95 checkout latency below 120 ms, verified by the checkout benchmark,
while keeping the correctness suite green. Use only checkout service files,
benchmark fixtures, and related tests. Between iterations, record what changed,
what the benchmark showed, and the next best experiment. If blocked, stop with
attempted paths, evidence, blocker, and next input needed.
```

## Runtime mapping in tap

Codex Goals continue at safe idle boundaries. Tap supports that as:

```json
{ "prompt": "...", "every": "idle", "maxRuns": 50 }
```

Copilot CLI autopilot can keep a session continuously busy, so `/tap-goal` also
supports timed autopilot-compatible goals:

```json
{ "prompt": "...", "everySchedule": ["2m", "5m", "10m"], "maxRuns": 50 }
```

Timed prompt sends that are deferred because the session is busy do not consume
the real iteration budget.

## Evidence audit before completion

Before a goal stops as complete, the prompt must record:

```text
GOAL COMPLETE
Verification surface checked: <specific evidence>
Result observed: <what it showed>
Constraints checked: <what did not regress>
Conclusion: complete
```

If the verification surface cannot be checked, the goal is blocked, not
complete.

## Iteration ledger

Each iteration should post a structured EventStream note with `tap_post`:

```text
ITERATION RECORD
Iteration: <runs> of <maxRuns>
Action taken: <smallest useful action>
Evidence checked: <test/output/artifact/result>
Status: progressing | complete | blocked | budget-limited
Next best action: <next step>
```

This makes the EventStream an audit trail rather than only a notification log.

## Research and reproduction goals

For research goals, maintain a claim ledger:

```text
Claim: <specific claim>
Route: <how it was tested>
Evidence surface: <what was checked>
Status: confirmed | approximate-support | blocked | uncertain
Remaining uncertainty: <what is missing>
```

The final output should preserve epistemic levels instead of flattening partial
support into success.

## Figure lessons from the Codex guide

The guide's figures reinforce these workflow rules:

1. A goal turns a one-turn exchange into an evidence-checked continuation loop.
2. Goal state is thread-scoped and includes durable state, continuation,
   controls, and evidence checks.
3. Continuation is gated: active goal, idle thread, and no queued user input.
4. Strong goals visibly name end state, verification surface, and constraints.
5. Research goals decompose source claims into evidence channels before status.
6. Final research output preserves confirmed, approximate, blocked, and
   uncertain support levels.
7. The UI example shows goal mode as an explicit command/input affordance rather
   than hidden background work.

## Budget handling

`maxRuns` is a safety budget. Reaching it means "budget-limited handoff," not
"goal complete." The final budget-limited iteration should post:

```text
BUDGET LIMITED
Progress: <what was achieved>
Evidence gathered: <what is known>
Remaining work: <what is not done>
Recommended next goal/budget: <next invocation>
```
