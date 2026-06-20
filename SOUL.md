# Why this repository exists

This repository is an agentic operating layer for Copilot CLI.

It is not just a collection of tap tools. It is a substrate that turns Copilot
from a turn-by-turn chat agent into a persistent, observable, interruptible, and
extensible worker that can notice background signals, remember live state, react
to events, and keep working against explicit goals.

## What it represents

1. **A nervous system for Copilot CLI**

   EventEmitters, EventStreams, EventFilters, and SessionInjectors are sensory
   and routing infrastructure. They let Copilot perceive background reality:
   logs, builds, PRs, providers, browser state, goals, and diagnostics.

2. **A control plane for safe autonomy**

   The point is not blind autonomy. The point is bounded autonomy with budgets,
   evidence checks, filters, ownership, persistence, diagnostics, and stop
   conditions. This is why `/tap-goal`, diagnostics, event filters, and
   ownership rules matter.

3. **A research lab for extensibility**

   The repository is where discoveries from Codex, Copilot CLI, the SDK,
   canvases, autopilot, tasks, providers, MCP, and runtime RPCs become working
   primitives.

4. **A bridge between external systems and the agent**

   Providers, Detour, command emitters, browser integrations, CI watchers,
   Jira/GitHub workflows, and local scripts all point to the same idea: Copilot
   should not be trapped inside the terminal transcript. It should be connected
   to the developer environment.

5. **A portable personal agent runtime**

   Publishing matters because this behavior should survive sessions, machines,
   reloads, and CLI upgrades. This is not a scratchpad; it is a reusable
   extension layer.

## The underlying thesis

Copilot CLI is powerful, but too episodic by default. This repository gives it
durable senses, live workflow memory, safe autonomy, and extension points so it
can operate like a real engineering assistant inside the user's environment.

In short: **tap is the middleware between raw Copilot intelligence and real-world
engineering operations.**
