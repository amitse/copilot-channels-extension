<p align="center">
  <img src="./tap.svg" width="80" height="80" alt="※ tap">
</p>

<h1 align="center">※ tap</h1>

<p align="center">
  <em>Background event filtering and injection for Copilot CLI.</em><br>
  <sub>Look here, this matters.</sub>
</p>

---

Copilot CLI already runs background tasks, but their output sits idle until you check it. This extension adds **filtering and auto-injection** on top of that capability.

Background commands and agent prompts produce output line by line. An EventFilter decides what to drop, what to store, and what to push into your session. Important events arrive without you asking.

| Without this extension | With it |
| --- | --- |
| You check background output manually | Important lines are pushed into your conversation |
| No way to filter noisy output | Rules drop noise, keep context, inject signal |
| No scheduled prompt re-runs | Prompts repeat on a timer or fire when idle |
| Output stays in the background task | Matched events arrive in your session as they happen |

## Who is this for?

- You tail logs and want failures injected into your session while you keep coding.
- You maintain a repo and want PR reviews, CI failures, or new issues surfaced automatically.
- You run long builds and want to know when they finish or break -- without watching.
- You poll an API or dashboard and want the agent to react when something changes.
- You re-ask the same prompt periodically and want it on a timer or running whenever idle.
- You build external tools in any language and want them available inside Copilot without touching the SDK.

## Get started

Prerequisites: [Node.js](https://nodejs.org/) ≥ 20 and [Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli).

> **Important:** This extension requires Copilot CLI to be running with **experiments enabled**. Extensions and background-task features are gated behind this flag.

**How to enable experiments:**

```bash
# Start Copilot CLI with experiments on
copilot --experimental
```

Or, if Copilot CLI is already running, type the following inside the session:

```
/experimental
```

Once enabled, the experimental state persists across sessions -- you only need to do this once. You can also disable it at any time with `copilot --no-experimental`.

### Install via npx (recommended)

```bash
# Install globally (available in all projects)
npx copilot-tap-extension

# Install locally (project-scoped, committed with your repo)
npx copilot-tap-extension --local
```

This installs the bundled extension, the `/tap-loop` skill, the `/tap-monitor` skill, the `/tap-goal` skill, and the agent instructions to the appropriate Copilot directory. Run `npx copilot-tap-extension --help` for all options.

To update to the latest version, re-run the same command with `--force`:

```bash
npx copilot-tap-extension --force
```

### Install from source

```bash
git clone https://github.com/amitse/copilot-tap-extension
cd copilot-tap-extension
npm install
cp tap.config.example.json tap.config.json
copilot
```

On Windows, replace `cp` with `copy`.

The config file tells the extension which emitters to auto-start. The example defines a heartbeat emitter:

```json
{
  "emitters": [
    {
      "name": "heartbeat",
      "command": "node ./examples/heartbeat.mjs",
      "autoStart": true,
      "eventFilter": [
        { "match": "booting", "outcome": "drop" },
        { "match": "warning|error", "outcome": "inject" },
        { "match": ".*", "outcome": "keep" }
      ]
    }
  ]
}
```

This runs the heartbeat script on session start, drops boot messages, injects warnings and errors, and keeps everything else in the stream.

Once inside the session, describe what you want in natural language. You can also use `/tap-loop` to set up scheduled prompts directly:

> _"Watch my build logs and tell me if anything fails"_

> _"/tap-loop 5m check for new PR review comments"_

> _"/tap-monitor tail -f /var/log/app.log"_

> _"/tap-goal migrate the repo to the new API and keep going until tests pass"_

> _"Tail the API logs, inject errors, drop health checks"_

The agent translates these into emitter and filter configurations behind the scenes.

## How it works

An **EventEmitter** is a background worker attached to your session. There are two kinds:

- A **CommandEmitter** runs a shell command and captures stdout line by line.
- A **PromptEmitter** runs an agent prompt -- once, on a recurring interval, or whenever the session is idle.

Each emitter writes to an **EventStream**, an in-memory log of accepted output. The stream is created automatically and shares the emitter's name.

For CommandEmitters, an **EventFilter** decides what happens to each line. It is an ordered list of regex rules -- first match wins:

| Outcome | What happens |
| --- | --- |
| **drop** | Discarded. Never enters the stream. |
| **keep** | Stored in the EventStream for later review. |
| **surface** | Stored and shown in the session timeline. |
| **inject** | Stored, shown, and pushed into your conversation. |

Outcomes are inclusive: **inject** implies **surface**, and **surface** implies **keep**. Only **drop** is outside this chain.

PromptEmitter output bypasses the filter and always injects.

A **SessionInjector** controls whether stream updates are pushed into your session proactively. Enable it when you want important events to arrive as they happen.

Filters are hot-swappable while the emitter runs. `ownership="modelOwned"` lets the agent tune rules; `ownership="userOwned"` locks them to your specification.

Emitters are **temporary** by default and last only for the current session. Set `lifespan="persistent"` to save an emitter to config and restore it next session.

Run schedules control timing: **continuous** (command runs until stopped), **timed** (repeats on an interval), **oneTime** (runs once), or **idle** (prompt re-runs when the session has nothing else to do).

## Extend with providers

External processes can register tools with your Copilot session through the **Provider Interface**. A provider connects via WebSocket to the ※ tap gateway (port 9400), authenticates with a token, and declares tools — no Copilot SDK knowledge required.

```bash
# Provider connects and registers a "greet" tool
TAP_PROVIDER_TOKEN=ptk-... node my-provider.mjs
```

Once connected, the tool appears alongside the existing ※ tap tools. Copilot can invoke it like any other tool, and the call is routed through the gateway to your provider.

Providers can be written in **any language** that supports WebSocket — Node.js, Python, Go, Rust, or anything else.

→ **[Provider guide](./docs/providers.md)** — Quick start, protocol reference, and examples.

## What you can do

**Watch something in the background**

Tell Copilot to watch a log, build, or command. It creates a CommandEmitter, filters the output, and only interrupts you when something needs attention.

```
"Start a deploy watcher that tails our CI logs.
 Drop health checks, inject any failures or rollbacks."
```

You keep coding. Twenty minutes later, Copilot interrupts: "Run 48291: deployment rollback triggered on prod."

**Monitor a command with self-tuning filters**

Use `/tap-monitor` to run a shell command continuously while a companion agent periodically reads the output and updates the filter expressions to separate noise from signal automatically.

```
/tap-monitor tail -f /var/log/app.log
/tap-monitor 10m docker logs -f mycontainer
```

The command stream starts with a sensible initial `notifyPattern`. Every few minutes (configurable) the companion reviews recent log lines and calls `tap_set_event_filter` if the patterns need adjustment. The filter tightens itself based on real output — no manual tuning required.

**Loop a prompt on a schedule**

A PromptEmitter re-runs an agent prompt at a fixed interval. Useful for PR comments, CI status, or ticket queues.

```
/tap-loop 15m Check for new failing CI runs or PR review comments.
         Summarize only actionable items.
```

Every 15 minutes the agent scans and reports back. No news means no interruption.

**Run a prompt when idle**

Use `/tap-loop idle` to re-run a prompt whenever the session has nothing else to do. Set `maxRuns` to cap iterations.

```
/tap-loop idle Scan for new issues labeled urgent. Summarize what changed.
```

The prompt fires immediately, then re-fires after each idle period. It stops after reaching the iteration limit.

**Work toward a goal autonomously**

Use `/tap-goal` to create an idle goal loop that keeps advancing a concrete objective until it finishes, hits a blocker, or reaches its iteration budget. It is modeled after Codex CLI's `/goal`: goals are explicit, control commands are user-owned, and the loop should stop itself only when the objective is actually complete or blocked.

```
/tap-goal migrate the repo to the new API and keep going until tests pass
```

The skill creates a temporary idle PromptEmitter with a self-contained goal prompt. Each iteration assesses progress, takes the next small action, validates when relevant, and stops the emitter when the goal is complete or blocked. Goal loops default to 10 iterations unless you specify another budget. Use `/tap-goal status` to list current goal emitters, and `/tap-goal pause`, `/tap-goal resume <objective>`, or `/tap-goal clear` to control a goal. Pause stops the ※ tap loop; resume starts a new loop from the supplied objective.

**Tune the filter live**

The recommended approach is a **keep-all bootstrap**: start with no EventFilter rules so all output flows into the stream. Read the stream history to learn what the output looks like, then add rules progressively:

```
1. Drop the noise:    { "match": "health_check|heartbeat", "outcome": "drop" }
2. Inject the signal: { "match": "error|failure|rollback",  "outcome": "inject" }
3. Keep the rest:     { "match": ".*",                       "outcome": "keep" }
```

Rules can be added or changed while the emitter is running. You never need to restart it to adjust filtering.

## Repo layout

```text
.github/
  extensions/tap/extension.mjs  # extension entry point (loads the runtime)
  skills/tap-loop/                  # /tap-loop skill for scheduled and idle prompts
  skills/tap-monitor/               # /tap-monitor skill for self-tuning command monitors
  skills/tap-goal/                  # /tap-goal skill for autonomous goal loops
  skills/tap-create-provider/       # /tap-create-provider skill for scaffolding external tool providers
  copilot-instructions.md       # agent guidance for using this extension
src/
  emitter/                      # supervisor, lifecycle, spawn, line router
  streams/                      # EventStream store and notification dispatcher
  provider/                     # WebSocket gateway for external tool providers
  tools/                        # tool definitions (emitters, streams, filters)
  config/                       # persistent config store (tap.config.json)
  format/                       # display formatters for emitters and streams
  session/                      # session port abstraction
  util/                         # normalization, text, time, path helpers
  hooks.mjs                     # session lifecycle hooks
  tap-runtime.mjs               # runtime factory (wires everything together)
tap.svg                         # ※ mark — the tap icon
docs/
  evolution-of-tap-icon.html    # design evolution: 20 agents, 20 metaphors, one mark
examples/heartbeat.mjs          # demo CommandEmitter
evals/                          # eval harness and test cases
tap.config.example.json         # starter config (copy to tap.config.json)
PLAN.md                         # ubiquitous language and design decisions
```

## Further reading

| Document | When to read it |
| --- | --- |
| [Reference](./docs/reference.md) | Look up tool parameters, config fields, or the event pipeline |
| [Provider guide](./docs/providers.md) | Add external tools to Copilot via the WebSocket provider interface |
| [Use cases and patterns](./docs/use-cases.md) | Recipes for deploy watchers, PR monitors, log tailers, and more |
| [Evals](./docs/evals.md) | Run or extend the automated test suite |
| [Copilot instructions](./src/copilot-instructions.md) | Understand or customize how the agent uses this extension |
| [Implementation plan](./PLAN.md) | Ubiquitous language and naming conventions for contributors |
| [Evolution of the ※ icon](./docs/evolution-of-tap-icon.html) | 20 metaphors, 10 variants, one mark — the design story behind ※ tap |

## Contributing

Before opening a PR, run the local checks:

```bash
npm run check              # syntax check
npm run evals:smoke        # smoke test
npm run evals:validate-modes  # interactive vs prompt-mode gap
```

The runtime has no production dependencies. Dev dependencies (`@github/copilot-sdk`, `yaml`) are used for the eval harness and extension loading.

If you add a new tool or change the event pipeline, update the [reference](./docs/reference.md). If you add a new workflow pattern, add it to [use cases](./docs/use-cases.md).

## License

[MIT](./LICENSE)
