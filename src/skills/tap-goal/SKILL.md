---
name: tap-goal
description: "Run an autonomous goal loop. Use when the user says 'goal', 'keep working until done', 'work autonomously', 'iterate until complete', or wants Codex-style long-horizon progress toward an objective."
argument-hint: "<objective>"
user-invocable: true
---

Create an idle PromptEmitter with `tap_start_emitter` that keeps advancing one explicit objective until the goal is achieved, blocked, stopped, or the iteration limit is reached.

This skill intentionally follows the Codex CLI `/goal` model:

- Goals are explicit; do not infer one from ordinary user tasks.
- A bare goal command reports the current goal state.
- Control commands are user-owned (`status`, `stop`, `resume`, `clear`, `replace`).
- The model can complete a goal only when the objective is actually achieved.
- Runtime budgets constrain further autonomous work; they are not proof of completion.

## Expected input

Interpret the invocation as one of:

1. No arguments — show current `goal-*` emitters with `tap_list_emitters`.
2. A control command — `status`, `stop`, `resume`, `clear`, or `replace`.
3. Otherwise, the full invocation is the goal objective.

Example:

```text
/tap-goal migrate the repo to the new API and keep going until tests pass
```

means:

- `objective = "migrate the repo to the new API and keep going until tests pass"`

If the objective is missing or too vague, ask the user for a concrete objective instead of guessing.

If another `goal-*` emitter already exists, ask before replacing it unless the user explicitly said `replace`.

## What to create

Use `tap_start_emitter` to create a **PromptEmitter**:

- `prompt` — a fully self-contained goal-loop prompt using the template below.
- `every = "idle"` — the loop advances only when the session is idle.
- `scope = "temporary"`, `managedBy = "modelOwned"`.
- `subscribe = false` — PromptEmitter output already reaches the session through `session.send()`.
- `maxRuns` — use the user's requested budget if provided; otherwise default to `10`.
- Name the emitter after the objective, prefixed with `goal-` (for example `goal-api-migration`).
- The EventStream is created automatically with the same name.

Do not set EventFilter rules. PromptEmitter output is dispatched through `session.send()` and bypasses line filtering, so EventFilter rules would not affect goal-loop output.

## Goal-loop prompt template

Write the prompt so it stands alone because it will run later without the original chat context:

```text
You are running a tap-goal autonomous goal loop.

Goal: <objective>

On this iteration:
1. Briefly assess current progress toward the goal.
2. If the goal is already achieved, call tap_stop_emitter for '<goal-emitter-name>' with scope='temporary', report that the goal is complete, and stop.
3. If the goal is blocked by missing information, permissions, failing external systems, or an unsafe action, report the blocker, call tap_stop_emitter for '<goal-emitter-name>' with scope='temporary', and stop.
4. Otherwise, choose the next smallest useful action toward the goal and perform it.
5. Validate the action using the repository's existing checks when relevant.
6. End with a concise progress update and what remains.

Safety rules:
- Do not make unrelated changes.
- Do not mark the goal complete unless the objective is actually achieved and no required work remains.
- Do not treat reaching the iteration budget as success.
- Do not continue if the next step requires explicit user approval.
- Prefer small reversible steps.
- Stop yourself when done or blocked; do not rely on the user to notice.
```

Substitute the real objective and emitter name before passing the prompt to `tap_start_emitter`.

## Required behavior

When this skill is invoked:

1. Parse the goal objective and any explicit iteration budget.
2. For a bare `/tap-goal` or `/tap-goal status`, call `tap_list_emitters`, summarize any `goal-*` emitters, and stop.
3. If the user is asking to stop, cancel, or clear an existing goal, call `tap_stop_emitter` for the named goal emitter and confirm that it will not fire again.
4. If the user is asking to pause an existing goal, explain that `/tap-goal` does not have Codex's state-preserving pause because it is implemented with PromptEmitters. Ask whether they want to stop the loop instead; only call `tap_stop_emitter` if they confirm.
5. If the user is asking to resume a goal, create a new `/tap-goal` loop with the resumed objective; ask for the objective if it is not clear.
6. Before creating a new goal, check for existing `goal-*` emitters. If one exists and the user did not explicitly ask to replace it, ask for confirmation before starting another goal loop.
7. Otherwise, create the idle PromptEmitter using the template above.
8. Confirm to the user:
   - Goal emitter name
   - EventStream name
   - Objective
   - Max iteration count
   - That it will advance when the session is idle and stop itself when complete or blocked
9. Stop there. Do not immediately perform the first goal iteration unless the user explicitly asks you to start working now.

## Iteration budget

Idle goal loops must always have `maxRuns`.

- If the user gives a budget, use it.
- Otherwise, default to `10`.
- If the objective is large, tell the user they can invoke `/tap-goal` again with a higher budget.

## Persistence

Default goal loops are temporary. If the user explicitly asks for a goal to survive future sessions, set `scope = "persistent"` and `autoStart = true`, but warn that long-running persistent goals should be used carefully because they will resume automatically on the next session start.
