---
name: tap-orchestrate
description: "Create a coordinator PromptEmitter for multi-agent tap workflows with role-specific sub-emitters, gated handoffs, and evidence records. Use when the user asks to orchestrate multiple agents, roles, workstreams, or parallel implementation/review/test phases."
argument-hint: "<objective and roles>"
user-invocable: true
---

Create a coordinator PromptEmitter that manages a multi-agent workflow using tap
emitters and EventStreams.

Use this for work that naturally decomposes into roles such as planner,
implementer, reviewer, tester, documenter, provider-builder, or release
coordinator. Do not use it for a single straightforward task.

## What to create

Use `tap_start_emitter` to create a **coordinator PromptEmitter**:

- Name: `orchestrate-<objective-slug>`.
- Prompt: a self-contained orchestration contract.
- Schedule: `everySchedule = ["2m", "5m", "10m"]`.
- `lifespan = "temporary"` unless the user explicitly asks for persistence.
- `ownership = "modelOwned"`.
- `subscribe = false`.
- `maxRuns = 50` unless the user gives a budget.

The coordinator may create role-specific PromptEmitters only when the role has a
clear deliverable and verification surface. Each role emitter should write its
handoff to an EventStream with a stable name:

```text
orchestrate-<objective>-<role>
```

## Coordinator prompt contract

The coordinator prompt must include:

```text
Objective: <user objective>
Roles: <role list, deliverables, and verification surface>
Gate policy:
- Do not hand off to the next role until required artifacts or EventStream notes exist.
- Read role EventStreams with tap_stream_history before deciding a gate is satisfied.
- If parallel work is safe, create independent role emitters in the same iteration.
- If a role blocks, post ORCHESTRATION BLOCKED and stop the coordinator.
Audit trail:
- After every decision, call tap_post to the coordinator stream with ORCHESTRATION RECORD:
  role, gate, evidence checked, decision, next handoff.
Safety:
- Do not spawn duplicate role emitters.
- Do not mutate another role's scope unless the coordinator evidence supports it.
- Stop all role emitters when the orchestration completes or blocks.
```

## Required behavior

1. Parse the objective and any requested roles.
2. If roles are missing, infer a minimal role set from the objective:
   planner, implementer, reviewer, validator.
3. Create the coordinator PromptEmitter only; do not immediately create role
   emitters in the setup turn. The coordinator will create them when it runs.
4. Confirm:
   - coordinator emitter name and stream
   - roles
   - gate policy
   - max iteration budget

## Good role patterns

- **planner**: produce plan and boundaries; verification is a plan note.
- **implementer**: make code/doc changes; verification is diff + focused checks.
- **reviewer**: inspect changes; verification is review note with findings.
- **validator**: run tests/build/evals; verification is command evidence.
- **release**: bump/push/publish only after validator passes.

## When not to use

Do not create orchestration for a normal `/tap-goal` objective that one agent can
complete directly. Orchestration adds coordination cost and should only be used
when parallel roles or gated handoffs are genuinely useful.
