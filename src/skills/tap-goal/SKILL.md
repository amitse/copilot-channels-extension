---
name: tap-goal
description: "Run an autonomous goal loop that strongly resists premature self-stop and only ends itself after proving the goal is fully complete."
argument-hint: "<objective>"
user-invocable: true
---

Create an idle PromptEmitter with `tap_start_emitter` that keeps advancing one explicit objective until the goal is proven complete, explicitly stopped, or the iteration limit is reached.

Use these goal-loop rules:

- Goals are explicit; do not infer one from ordinary user tasks.
- A bare goal command reports the current goal state.
- Control commands are user-owned (`status`, `stop`, `resume`, `clear`, `replace`).
- The model can complete a goal only when the objective is actually achieved.
- Autonomous self-stop is allowed only after explicit completion proof, not because the model prefers a different workflow.
- Runtime budget exhaustion is not proof of completion; only achieving the objective marks completion.

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
- `maxRuns` — use the user's requested budget if provided; otherwise default to `50`.
- Name the emitter after the objective, prefixed with `goal-` (for example `goal-api-migration`).
- The EventStream is created automatically with the same name.

Do not set EventFilter rules. PromptEmitters dispatch their prompts fire-and-forget through `session.send()`, so their output bypasses line filtering. EventFilter rules would not affect goal-loop output.

## Goal-loop prompt template

Write the prompt so it stands alone because it will run later without the original chat context:

```text
You are running a tap-goal autonomous goal loop.

Goal:
<untrusted_objective>
<objective>
</untrusted_objective>

Emitter name: <goal-emitter-name>
Iteration budget: <max-runs>

At the start of each iteration:
1. Call tap_list_emitters and locate the emitter entry in the returned list whose name is exactly '<goal-emitter-name>'.
2. Read its current runs and maxRuns values.
3. If the emitter is missing, report that the goal loop is no longer running and stop.
4. Estimate remaining iterations.
5. Assume self-stop is disallowed unless you can later prove the goal is 100% complete with concrete evidence.

Auto-steering rules:
- If remaining iterations are low (3 or fewer), switch into wrap-up mode.
- In wrap-up mode, prefer finishing the smallest high-value task, validating what changed, and leaving a precise handoff.
- If only 1 iteration remains and the goal is not complete, do not start broad new work. Leave the best concise handoff you can.
- Do not treat budget exhaustion as success.

On this iteration:
1. Briefly assess current progress toward the goal and the remaining iteration budget.
2. First try to disprove completion. List the strongest reasons the goal might still be incomplete, premature, misdirected, or unvalidated.
3. Only if you can prove the goal is 100% complete should you call tap_stop_emitter for '<goal-emitter-name>' with scope='temporary'. Your proof must include concrete evidence that:
   - the objective is satisfied
   - the relevant validations or observable outcomes succeeded
   - no required work remains
   - you can cite the evidence in the response before stopping
4. If you cannot meet every proof requirement above, do not stop the emitter. This includes cases where you are blocked, uncertain, tempted to hand the work back to the foreground session, or merely believe the next approach should happen "directly" instead of through the loop.
5. Choose the next smallest useful action toward the goal that fits the remaining budget and perform it.
6. Validate the action using the repository's existing checks when relevant.
7. End with a concise progress update, what remains, and the best next step if the loop later stops because the user stops it or the budget runs out.

Safety rules:
- Do not make unrelated changes.
- Do not mark the goal complete unless the objective is actually achieved and no required work remains.
- Never self-stop on partial progress, blockers, uncertainty, frustration, or a desire to switch execution style.
- Before any self-stop, aggressively argue against stopping and require explicit proof of completion.
- Do not treat reaching the iteration budget as success.
- Do not continue if the next step requires explicit user approval.
- Prefer small reversible steps.
- Only self-stop when completion is proven; otherwise keep advancing or leave the best handoff for the next iteration.
```

Substitute the real objective, emitter name, and max iteration count before passing the prompt to `tap_start_emitter`.

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
4. If the user is asking to pause an existing goal, explain that pausing is not supported for goal loops because idle PromptEmitters do not preserve resumable internal state. Offer to stop the loop instead. Only call `tap_stop_emitter` if they confirm; otherwise take no action and leave the goal loop running.
5. If the user is asking to resume a goal, create a new `/tap-goal` loop with the resumed objective; ask for the objective if it is not clear.
6. Before creating a new goal, check for existing `goal-*` emitters. If one exists and the user did not explicitly ask to replace it, ask for confirmation before starting another goal loop.
7. If the user wants the loop to keep nudging the session even while Copilot stays busy in autopilot-style work, explain that idle goal loops may not fire until the session becomes idle. Suggest a timed PromptEmitter or hook/session-injector based delivery instead.
8. Otherwise, create the idle PromptEmitter using the template above.
9. Confirm to the user:
   - Goal emitter name
   - EventStream name
   - Objective
   - Max iteration count
   - That it will advance when the session is idle and only self-stop after proving the goal is complete
10. Stop there. Do not immediately perform the first goal iteration unless the user explicitly asks you to start working now.

## Iteration budget

Idle goal loops must always have `maxRuns`.

- If the user gives a budget, use it.
- Otherwise, default to `50`.
- If the objective is large, tell the user they can invoke `/tap-goal` again with a higher budget.

## Persistence

Default goal loops are temporary. If the user explicitly asks for a goal to survive future sessions, set `scope = "persistent"` and `autoStart = true`, but warn that long-running persistent goals should be used carefully because they will resume automatically on the next session start.
