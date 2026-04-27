# Beyond Watch-Filter-Inject — Deep Ideas

The 100 ideas catalog covers the obvious pattern: run a command, filter output, inject into session. That's the "hello world" of tap. These ideas explore what becomes possible when you think harder about what the platform uniquely enables.

---

## What makes tap different from every other tool?

1. **It lives inside the AI reasoning loop.** It doesn't just show you data — it changes how the AI thinks by injecting context before the model reasons.
2. **It intercepts tool calls.** `onPreToolUse` / `onPostToolUse` hooks can modify, enhance, gate, or redirect ANY tool call the agent makes.
3. **It has AI-calling-AI.** PromptEmitters are scheduled AI invocations — not shell commands, but reasoning on a timer.
4. **It accumulates state across turns.** EventStreams are rolling memory that persists within and across sessions.
5. **It can register/unregister tools at runtime.** The agent's capabilities change based on what's happening.

The 100 ideas treat tap as a pipe. These ideas treat it as a **cognitive layer**.

---

## Idea 1: Reflexive Self-Improvement

**The extension watches the agent and makes it better.**

The agent makes tool calls, writes code, runs tests. An extension watches all of this via `onPostToolUse` and `assistant.message` events. It builds a model of what works and what doesn't:

- Which tool calls fail and why
- Which code patterns lead to test failures
- Which instructions the user has to repeat

Then it injects learned corrections into session context: "When editing Python in this repo, always run black after edits — you've been corrected 3 times." The agent gets better over sessions without anyone writing new instructions.

**Why this is novel:** The extension IS the agent's long-term memory and learning system. Not a static instructions file — a living, adapting context layer.

**Core mechanism:** `onPostToolUse` hook → track outcomes → EventStream as learning journal → `onSessionStart` injects accumulated lessons.

---

## Idea 2: Attention Budget

**Not everything deserves to interrupt the AI. The extension decides what does.**

Current model: EventFilter is static regex rules. New model: an attention budget that's dynamic. The extension tracks:

- What the user is currently working on (from recent tool calls and messages)
- How important each incoming event is (not just regex — semantic relevance)
- How many interruptions have happened recently (fatigue modeling)

A PromptEmitter periodically reviews the EventStream and re-ranks what should be injected vs. kept vs. dropped. The filter rules themselves are AI-generated and hot-swapped based on context.

**Why this is novel:** The EventFilter becomes intelligent. It doesn't just pattern-match — it reasons about relevance. "You're debugging a CSS issue, so suppress the CI failure for the backend service, but surface the Playwright screenshot regression."

**Core mechanism:** PromptEmitter (idle schedule) reads recent conversation + EventStream → generates new EventFilter rules → `tap_set_event_filter` hot-swaps them.

---

## Idea 3: Tool Interception Layer

**Every tool call passes through an enhancement/gating layer.**

`onPreToolUse` and `onPostToolUse` are the most underexplored hooks. They let you:

- **Enhance:** Before `edit` runs, inject linting context. After `edit` runs, auto-run the formatter.
- **Gate:** Before `shell(rm -rf)` runs, check if it's in a protected directory.
- **Augment:** After `grep` returns results, automatically add file summaries.
- **Redirect:** Before an API call, check if there's a cached result in the EventStream.
- **Record:** Log every tool call into an EventStream for replay, audit, or debugging.

This turns tap into a **middleware layer** for the agent's actions. Think Express.js middleware but for AI tool calls.

**Why this is novel:** You're not adding tools — you're modifying all existing tools. One extension can change the behavior of every tool in the system.

**Example:** An extension that intercepts every `edit` tool call, runs the edit, then immediately spawns `eslint --fix` on the file. The agent never produces unlinted code. Zero changes to the agent's instructions needed.

---

## Idea 4: Multi-Agent Debate Protocol

**Multiple PromptEmitters that cross-check each other's work.**

Instead of one AI doing everything, set up competing perspectives:

- **Builder emitter:** "Implement this feature"
- **Critic emitter:** On idle, reviews what Builder did and injects objections
- **Security emitter:** On every file edit, checks for vulnerabilities
- **Simplicity emitter:** On idle, asks "can this be simpler?"

They don't talk to each other directly — they all inject into the same session. The main agent synthesizes their perspectives. It's a **council pattern** where the user gets the benefit of multiple viewpoints without managing multiple sessions.

**Why this is novel:** AI-to-AI coordination through shared EventStreams. Each emitter specializes and challenges the others. The quality of output improves because no single perspective dominates.

**Core mechanism:** Multiple PromptEmitters on idle schedule, each with a different system prompt and focus area. EventStreams provide shared context.

---

## Idea 5: Capability Discovery via Universal Tool Gateway

**The agent's abilities change based on what's running on your machine.**

Combine the universal tool gateway with session context injection:

- Docker is running → container management tools appear, agent knows it can deploy locally
- Postgres is running → database query tools appear, agent knows the schema
- Browser has a React app open (via Detour bridge) → React component tools appear
- kubectl is configured → Kubernetes tools appear
- Nothing is running → agent works with just files and git

The agent's instructions dynamically update: "You currently have access to: local Postgres (myapp_dev), Docker (3 containers running), and the React app at localhost:3000."

**Why this is novel:** The agent is context-aware about the developer's environment at runtime. Not "what tools exist" but "what tools are available right now." It can suggest actions based on what's actually possible.

**Core mechanism:** Bridge server polls or receives hellos from providers → tap calls `session.registerTools()` AND injects updated capability description into session context via `onUserPromptSubmitted` hook.

---

## Idea 6: Session Handoff

**Pass work between sessions with full context.**

You're working on a feature in Session A. You need to context-switch to debug a production issue. Instead of losing context:

1. The extension serializes Session A's EventStreams, current state, and a PromptEmitter-generated summary into a handoff artifact.
2. Session B starts with the production issue. The extension notes this is a different context.
3. When you return to feature work, Session C starts. The extension detects the topic match and injects the Session A handoff artifact as context.

**Why this is novel:** Extensions bridge the gap between ephemeral sessions. Your work doesn't evaporate when you switch contexts. The extension is your **working memory across sessions**.

**Core mechanism:** `onSessionEnd` hook serializes state → persistent config + file artifact. `onSessionStart` hook checks for relevant handoff artifacts → injects as additionalContext.

---

## Idea 7: Workflow Recorder → Replay

**Watch what a human does, then replay it as an automated workflow.**

The extension records every meaningful action during a session: which files were edited, what commands were run, what tools were called, in what order. It builds a **workflow graph**.

Later, you say "do what I did last time when deploying" and the extension replays the workflow — but through the AI, so it adapts to the current context (different branch, different files, different state).

**Why this is novel:** It's not a shell script recording. It's capturing intent at the tool-call level and replaying it through an AI that can handle variations. Brittle automation becomes adaptive automation.

**Core mechanism:** `onPostToolUse` hook records tool calls into EventStream → `onSessionEnd` distills into workflow template → PromptEmitter can replay by injecting the template as instructions.

---

## Idea 8: Semantic Event Correlation

**Events from different streams that are related find each other.**

You have three emitters running: CI watcher, error log tailer, and PR comment monitor. They produce events independently. But:

- CI fails at 2:03pm
- Error logs spike at 2:03pm
- A PR comment at 1:55pm said "this might break staging"

A correlation engine (PromptEmitter on idle) reads across all EventStreams and connects these: "CI failure correlates with error spike; both likely caused by PR #247 (commenter warned about this)."

**Why this is novel:** Individual emitters are dumb pipes. The correlation layer creates intelligence by reading across streams. This is how humans reason about incidents — connecting signals from different sources.

**Core mechanism:** PromptEmitter (idle) reads history from all streams → reasons about correlations → injects synthesis as a single high-signal event.

---

## Idea 9: Progressive Disclosure of Complexity

**The extension starts simple and grows capabilities as you need them.**

New user gets: one tool, one emitter pattern, minimal instructions. As the extension observes what you do, it progressively:

- Suggests new emitters based on your patterns ("I notice you check CI manually every 10 minutes — want me to watch it?")
- Offers to persist useful temporary emitters
- Proposes EventFilter refinements based on what you ignore vs. react to
- Surfaces advanced features only when they'd help

**Why this is novel:** Most tools dump all features on you day one. This extension **teaches itself to you** by observing what you need. The onboarding IS the product.

**Core mechanism:** PromptEmitter (idle, low frequency) reviews session patterns → compares against known recipes → suggests next capability via `session.send()`.

---

## Idea 10: Extension as API Gateway

**Any external API becomes a tool without writing an extension.**

User says: "I want to be able to query our Jira board." Instead of writing a Jira extension:

1. tap registers a generic `tap_api` tool
2. User provides the API spec (OpenAPI/Swagger URL or a few example curl commands)
3. tap generates typed tools from the spec at runtime via `session.registerTools()`
4. The agent can now query Jira, create tickets, update status

The API definition lives in `tap.config.json`. Add a new API? Add an entry to config. No code.

**Why this is novel:** It collapses the "extension per service" model into "config per service." The 100 ideas list has CVEWatch, PipelineWatch, SLAWatch — they're all "call an API and filter results." With a generic API gateway, you configure them instead of coding them.

**Core mechanism:** Config-driven API definitions → `onSessionStart` generates Tool objects with handlers that make HTTP calls → `session.registerTools()`.

---

## The Meta-Pattern

The 100 ideas are all instances of: **run a thing → filter output → show it to the AI.**

The deeper ideas are instances of: **observe the system (including the AI itself) → reason about what matters → change the AI's behavior.**

The shift is from **tap as a pipe** to **tap as a cognitive layer:**

| Surface level | Deep level |
|---|---|
| Watch CI logs | Watch the agent's own failures and learn from them |
| Filter by regex | Filter by semantic relevance to current task |
| Inject events | Change what tools exist and how they behave |
| One emitter per service | One gateway that discovers services at runtime |
| Static instructions | Instructions that evolve based on observed patterns |
| Single session | Context that flows across sessions |
| One AI perspective | Multiple AI perspectives that debate |

The universal tool gateway was the first example of this shift. These ideas continue it.
