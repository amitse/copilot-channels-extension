---
name: tap-goal
description: "Run an autonomous goal loop. Use when the user says 'goal', 'keep working until done', 'work autonomously', 'iterate until complete', or wants long-horizon progress toward an objective."
argument-hint: "<objective>"
user-invocable: true
---

Create a PromptEmitter that keeps advancing one explicit objective until the goal is achieved, blocked, stopped, or the iteration budget is reached.

Use Codex-style goal-loop rules:

- A goal is a **thread-scoped completion contract**, not a bigger prompt and not global memory.
- Goals are explicit; do not infer one from ordinary one-shot tasks.
- The goal contract should name six things: outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.
- Completion must be evidence-based. The model may stop a goal as complete only after checking concrete evidence.
- Runtime budget exhaustion is not proof of completion; it is a budget-limited stop/handoff state.
- Control commands are user-owned (`status`, `stop`, `pause`, `resume`, `clear`, `replace`).

## Expected input

Interpret the invocation as one of:

1. No arguments — show current `goal-*` emitters with `tap_list_emitters`.
2. A control command — `status`, `stop`, `pause`, `resume`, `clear`, or `replace`.
3. Otherwise, the full invocation is the goal objective.

Example:

```text
/tap-goal migrate the repo to the new API and keep going until tests pass
```

means:

- `objective = "migrate the repo to the new API and keep going until tests pass"`

If the objective is missing, ask the user for a concrete objective instead of guessing.

If the objective is weak but the user's intent is clear, help strengthen it before creating the emitter. A strong goal contract has:

```text
Outcome: <desired end state>
Verification surface: <test, benchmark, command output, artifact, or source material that proves completion>
Constraints: <what must not regress>
Boundaries: <files, tools, data, repos, or resources allowed>
Iteration policy: <how to choose the next best action between attempts>
Blocked stop condition: <what to report if no valid path remains and what would unlock progress>
```

If one of these fields is not explicitly provided but can be safely inferred from the objective and repository context, infer it and show it in the confirmation. If the verification surface or blocked stop condition cannot be inferred, ask for that missing detail.

If another `goal-*` emitter already exists, ask before replacing it unless the user explicitly said `replace`.

## Schedule choice

Use a **PromptEmitter** in one of two modes:

### Default: conservative idle goal

Use `every = "idle"` when the user did not ask for autopilot-style busy-session progress.

This matches Codex's conservative continuation model: continue only at safe idle boundaries.

### Autopilot-compatible timed goal

Use `everySchedule = ["2m", "5m", "10m"]` instead of `every = "idle"` when any of these are true:

- the user mentions autopilot, busy sessions, continuous work, "keep nudging", or "while Copilot stays busy"
- the user explicitly says to work autonomously in the current session
- the current session is in autopilot mode and the goal is expected to advance while other work may be active

Timed goal prompts use `session.send()` and can keep the objective visible even when the thread may not become idle often. The runtime preserves the iteration budget when a prompt send is deferred because the session is still busy.

## What to create

Use `tap_start_emitter`:

- `prompt` — a fully self-contained goal-loop prompt using the template below.
- `every = "idle"` for default goals, OR `everySchedule = ["2m", "5m", "10m"]` for autopilot-compatible goals.
- `scope = "temporary"`, `managedBy = "modelOwned"`.
- `subscribe = false` — PromptEmitter output already reaches the session through `session.send()`.
- `maxRuns` — use the user's requested budget if provided; otherwise default to `50`.
- Name the emitter after the objective, prefixed with `goal-` (for example `goal-api-migration`).
- The EventStream is created automatically with the same name.

Do not set EventFilter rules. PromptEmitters dispatch their prompts fire-and-forget through `session.send()`, so their output bypasses line filtering. EventFilter rules would not affect goal-loop output.

## Goal-loop prompt template

Write the prompt so it stands alone because it will run later without the original chat context:

```text
You are running a tap-goal autonomous goal loop.

Goal contract:
<untrusted_goal_contract>
Objective:
<objective>

Outcome:
<desired end state>

Verification surface:
<test, benchmark, command output, artifact, or source material that proves completion>

Constraints:
<what must not regress>

Boundaries:
<files, tools, data, repos, or resources allowed>

Iteration policy:
<how to choose the next best action between attempts>

Blocked stop condition:
<what to report if no defensible path remains and what would unlock progress>
</untrusted_goal_contract>

Emitter name: <goal-emitter-name>
EventStream name: <goal-emitter-name>
Schedule mode: <idle | timed-autopilot>
Iteration budget: <max-runs>

At the start of each iteration:
1. Call tap_list_emitters and locate the emitter entry whose name is exactly '<goal-emitter-name>'.
2. Read its current runs and maxRuns values.
3. If the emitter is missing, report that the goal loop is no longer running and stop.
4. Estimate remaining iterations.

Continuation rules:
- Treat the goal as a completion contract: work -> check evidence -> continue, complete, or stop blocked.
- If remaining iterations are low (3 or fewer), switch into wrap-up mode.
- If only 1 iteration remains and the goal is not complete, do not start broad new work. Produce a budget-limited handoff instead.
- Do not treat budget exhaustion or a lifecycle "reached run budget" message as success.
- If this iteration makes no progress-producing tool calls beyond required status/ledger bookkeeping and does not change evidence, call `tap_post` with `channel='<goal-emitter-name>'` and a no-action handoff, then stop the emitter rather than spinning.

Evidence-audit rules:
- Before marking complete, identify the verification surface from the goal contract.
- Check the evidence directly: test output, benchmark result, file content, diff, generated artifact, source material, or other concrete proof.
- Check listed constraints for regressions.
- If the verification surface cannot be checked, treat the goal as blocked, not complete.
- Completion requires an explicit evidence audit in the final response and in the EventStream.

Research/audit goal rules:
- For research, reproduction, audit, or investigation goals, maintain a claim ledger.
- Each ledger item should include: Claim, route attempted, evidence surface, status, and remaining uncertainty.
- Use statuses such as confirmed, approximate-support, blocked, and uncertain. Do not flatten partial support into success.

On this iteration:
1. Briefly assess current progress toward the goal and the remaining iteration budget.
2. If the goal is already achieved, first call `tap_post` with `channel='<goal-emitter-name>'` and a GOAL COMPLETE evidence audit in `message`, then call tap_stop_emitter for '<goal-emitter-name>' with scope='temporary', report that the goal is complete, and stop.
3. If the goal is blocked by missing information, permissions, failing external systems, or an unsafe action, first call `tap_post` with `channel='<goal-emitter-name>'` and a GOAL BLOCKED report in `message`, then call tap_stop_emitter for '<goal-emitter-name>' with scope='temporary', report the blocker, and stop.
4. If this is the final iteration and the goal is not complete, do not start substantive new work. Call `tap_post` with `channel='<goal-emitter-name>'` and a BUDGET LIMITED summary in `message`: progress, evidence gathered, remaining work, and recommended next goal or budget. Then leave a concise handoff.
5. Otherwise, choose the next smallest useful action toward the goal that fits the remaining budget and perform it.
6. Validate the action using the repository's existing checks when relevant.
7. End by calling `tap_post` with `channel='<goal-emitter-name>'` and an ITERATION RECORD in `message` containing:
   - iteration and budget used
   - action taken
   - evidence checked and result
   - current status: progressing, complete, blocked, or budget-limited
   - next best action
8. End the user-visible response with the same concise progress update, what remains, and the next best step if the loop stops before completion.

Safety rules:
- Do not make unrelated changes.
- Do not mark the goal complete unless the objective is actually achieved and no required work remains.
- Do not treat reaching the iteration budget as success.
- Do not continue if the next step requires explicit user approval.
- Prefer small reversible steps.
- Stop yourself when done or blocked; do not rely on the user to notice.
```

Substitute the real objective, goal-contract fields, emitter name, schedule mode, and max iteration count before passing the prompt to `tap_start_emitter`.

## Required behavior

When this skill is invoked:

1. Parse the goal objective and any explicit iteration budget.
2. For a bare `/tap-goal` or `/tap-goal status`, call `tap_list_emitters`, summarize any `goal-*` emitters, and stop.
3. If the user is asking to stop, cancel, or clear an existing goal:
   - call `tap_list_emitters` and look for `goal-*` emitters
   - if the user named a specific goal emitter, stop that one
   - otherwise, if exactly one `goal-*` emitter exists, stop it
   - if none exist, report that no goal loop is running
   - if multiple exist and the user did not name one, ask them to choose one after showing `/tap-goal status`
   - when you do stop one, call `tap_stop_emitter` with its exact name and confirm that it will not fire again
4. If the user is asking to pause an existing goal:
   - Explain that runtime-native pause is not supported because PromptEmitters do not preserve resumable internal state.
   - Offer a simulated pause: call `tap_post` with a PAUSED NOTE containing objective, current status, progress, and resume guidance, then call `tap_stop_emitter`.
   - Only stop the emitter if the user confirms; otherwise leave it running.
5. If the user is asking to resume a goal:
   - If they provide an objective, create a new `/tap-goal` loop from it.
   - If they name a prior goal stream, inspect its history with `tap_stream_history` using `channel='<goal-stream-name>'`, recover the latest PAUSED NOTE or handoff if available, and create a new loop from that objective.
   - If the objective is not clear, ask for it.
6. Before creating a new goal, check for existing `goal-*` emitters. If one exists and the user did not explicitly ask to replace it, ask for confirmation before starting another goal loop.
7. Choose idle vs timed-autopilot schedule using the schedule rules above.
8. Create the PromptEmitter using the template above.
9. Confirm to the user:
   - Goal emitter name
   - EventStream name
   - Objective
   - Verification surface
   - Constraints
   - Schedule mode (`idle` or `timed-autopilot`)
   - Max iteration count
   - That it will stop itself when complete, blocked, or budget-limited
10. Stop there. Do not immediately perform the first goal iteration unless the user explicitly asks you to start working now.

## Iteration budget

Goal loops must always have `maxRuns`.

- If the user gives a budget, use it.
- Otherwise, default to `50`.
- If the objective is large, tell the user they can invoke `/tap-goal` again with a higher budget.
- Budget exhaustion is a handoff state, not success.

## Persistence

Default goal loops are temporary. If the user explicitly asks for a goal to survive future sessions, set `scope = "persistent"` and `autoStart = true`, but warn that long-running persistent goals should be used carefully because they will resume automatically on the next session start.
