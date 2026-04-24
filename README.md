# copilot-tap-extension

### Your Copilot CLI, but it watches things for you.

> **Background commands. Filtered output. Smart interrupts. You keep coding.**

[![Built for Copilot CLI](https://img.shields.io/badge/Copilot_CLI-Extension-blue?style=flat-square&logo=github)](https://github.com/features/copilot)
[![Zero Dependencies](https://img.shields.io/badge/deps-0-brightgreen?style=flat-square)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)]()

---

**Without this extension**, you alt-tab to check logs, poll dashboards, and re-ask Copilot the same question every few minutes.

**With it**, you say _"watch the deploy logs, tell me if anything breaks"_ — and go back to coding. The extension tails commands, filters noise, and injects only the important lines back into your conversation.

Not an MCP server. Not a custom agent. One `.github/extensions/` file.

## Who is this for?

- **You're debugging a deploy** and want to keep coding while logs stream in the background
- **You maintain a repo** and want PR comments, CI failures, and issues surfaced automatically
- **You run long builds** and don't want to babysit them
- **You poll APIs or dashboards** and want Copilot to tell you when something changes
- **You repeat the same prompt** every few minutes and want to automate it

If you've ever wished Copilot could _watch something for you_, this is that.

## Get started in 60 seconds

```bash
git clone https://github.com/amitse/copilot-tap-extension
cd copilot-tap-extension
cp tap.config.example.json tap.config.json
copilot
```

Then say any of these:

> _"Watch my build logs and tell me if anything fails"_

> _"/loop 5m check for new PR review comments"_

> _"Tail the API logs, inject errors, drop health checks"_

That's it. The example config auto-starts a demo heartbeat emitter so you see it working immediately.

## Three things you can do right now

**1. Watch something in the background**

Tell Copilot to watch a log, build, or command. It creates a background emitter, filters the noise, and only interrupts you when something actually needs your attention.

```
"Start a deploy watcher that tails our CI logs.
 Drop health checks, inject any failures or rollbacks."

→ You keep coding for 20 minutes.
→ Copilot interrupts: "Run 48291: deployment rollback triggered on prod"
```

**2. Loop a prompt on a schedule**

Have the agent re-check something every N minutes — PR comments, CI status, ticket queues — without you asking again.

```
/loop 15m Check for new failing CI runs or PR review comments.
         Summarize only actionable items.

→ Every 15 minutes, the agent scans and reports back.
→ No news = no interruption.
```

**3. Tune the filter live**

Every emitter has an EventFilter — regex rules that decide what gets dropped, kept, surfaced, or injected. The agent can tune these in real-time while you work, or you can lock them down with `ownership="userOwned"` so they stay exactly how you set them.

## How it works (30-second version)

```
                        Without tap              With tap
                        ──────────────           ──────────────
You:                    alt-tab, check logs      keep coding
Build fails at 2:47pm:  you notice at 3:15pm     injected immediately
PR gets reviewed:        you check manually       agent tells you
CI flakes:               buried in notifications  filtered + surfaced
```

Under the hood:

```
You define an emitter (a command or a prompt)
    |
    v
It runs in the background, producing output
    |
    v
EventFilter decides per line: drop / keep / surface / inject
    |
    v
Important events get injected into your Copilot session
```

- **drop** — discard, never stored
- **keep** — store silently in the event stream
- **surface** — store + show in the session timeline
- **inject** — store + show + push into the conversation

Prompt-based emitters always inject. Command-based emitters go through the filter.

## Repo layout

```text
.github/extensions/tap/extension.mjs   # the extension
.github/copilot-instructions.md        # agent guidance
tap.config.example.json                 # starter config
examples/heartbeat.mjs                  # demo emitter
docs/                                   # detailed docs
```

## Go deeper

| Doc | What's in it |
| --- | --- |
| **[Reference](./docs/reference.md)** | Full vocabulary, all tools, config schema, event pipeline details |
| **[Use cases and patterns](./docs/use-cases.md)** | Real-world workflows and recipes |
| **[Evals](./docs/evals.md)** | Testing infrastructure, smoke tests, interactive eval runner |
| **[Copilot instructions](./.github/copilot-instructions.md)** | How the agent is told to use this extension |
| **[Implementation plan](./PLAN.md)** | Design decisions and roadmap |

## Validate locally

```bash
npm run check              # syntax check
npm run evals:smoke        # smoke test
npm run evals:validate-modes  # interactive vs prompt-mode gap
```

---

**Ready to try it?** Clone the repo, copy the example config, launch `copilot`, and ask it to watch something. You'll see the difference in under a minute.
