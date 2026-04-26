# Recipe: Adaptive Agent — Self-Tuning Behavior via Session Observation

## The insight

Every Copilot session starts from zero. The AI doesn't know that you corrected it about the import style yesterday. It doesn't know that you always run tests after editing test files. It doesn't know that the last 3 times it suggested `jsonwebtoken`, you replaced it with the project's custom JWT library.

Skills can encode known rules. But they can't **discover** rules by observing what happens in sessions. The Adaptive Agent watches the session — tool calls, user corrections, assistant mistakes — and builds a living knowledge base that rewrites the system prompt via transform callbacks. The agent gets better over time, not because someone wrote instructions, but because the extension observed and learned.

## Why skills can't do this

1. A skill is static text. It can say "use custom JWT library." But someone has to write that rule. The adaptive agent discovers it by watching you replace `jsonwebtoken` twice.
2. A skill can't watch `assistant.message` events to detect when the AI makes a mistake. The extension can.
3. A skill can't watch `user.message` events to detect correction patterns ("no, actually..."). The extension can.
4. A skill can't rewrite its own content. Transform callbacks can modify the system prompt every turn based on accumulated observations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Copilot CLI session                                         │
│                                                             │
│  session.on("user.message") ─────┐                          │
│  session.on("assistant.message")──┤                          │
│  onPostToolUse ───────────────────┤                          │
│                                   ▼                          │
│                        ┌──────────────────┐                  │
│                        │  Observer Module  │                  │
│                        │                  │                  │
│                        │  Detects:        │                  │
│                        │  • Corrections   │                  │
│                        │  • Patterns      │                  │
│                        │  • Failures      │                  │
│                        │  • Preferences   │                  │
│                        └────────┬─────────┘                  │
│                                 │                             │
│                                 ▼                             │
│                        ┌──────────────────┐                  │
│                        │  Memory Store    │                  │
│                        │  (workspace/     │                  │
│                        │   memory.json)   │                  │
│                        └────────┬─────────┘                  │
│                                 │                             │
│                                 ▼                             │
│                        ┌──────────────────┐                  │
│                        │  Transform       │                  │
│                        │  Callbacks       │──► system prompt  │
│                        │  (every turn)    │   rewritten with  │
│                        │                  │   learned rules   │
│                        └──────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
         │
         │ onSessionEnd
         ▼
┌──────────────────┐
│  Distill          │
│  PromptEmitter    │
│  (one-time)       │
│                  │
│  Summarize what   │
│  was learned      │
│  this session     │
│  → persist to     │
│  memory.json      │
└──────────────────┘
```

## Components

### 1. Observer module (event listeners)

Hooks into three event sources to watch the session:

```js
// Watch user messages for correction patterns
session.on("user.message", (event) => {
  const msg = event.data.content?.toLowerCase() ?? "";
  // Detect corrections: "no", "actually", "don't use", "wrong", "instead"
  if (correctionPattern.test(msg)) {
    observer.recordCorrection({
      userMessage: event.data.content,
      // The previous assistant message is what was wrong
      previousAssistantAction: observer.lastAssistantAction,
      timestamp: Date.now()
    });
  }
});

// Watch assistant messages to track what the AI does
session.on("assistant.message", (event) => {
  observer.lastAssistantAction = {
    content: event.data.content,
    toolRequests: event.data.toolRequests
  };
});

// Watch tool calls to track workflow patterns
onPostToolUse: ({ toolName, toolArgs, result }) => {
  observer.recordToolUse({
    tool: toolName,
    args: toolArgs,
    succeeded: result.type === "success",
    file: toolArgs?.path || toolArgs?.file,
    timestamp: Date.now()
  });
}
```

### 2. Pattern detection

The observer accumulates raw events. A PromptEmitter on idle periodically distills patterns:

```
prompt: |
  Review these raw observations from the current session and extract
  durable learnings. Only output learnings that:
  - Are specific to THIS codebase (not generic advice)
  - Were demonstrated at least once clearly
  - Would prevent a future mistake or save time

  Format each as a single instruction sentence.
  Output nothing if no clear learnings emerged.

  Observations:
  {{corrections}}
  {{tool_failures}}
  {{repeated_sequences}}
```

Example output:
```json
[
  "Use the custom JWT library at src/lib/jwt.ts instead of jsonwebtoken — user corrected this.",
  "Always run npm test after editing files in test/ — user does this manually every time.",
  "The staging environment uses port 3001, not 3000 — the agent used the wrong port twice."
]
```

### 3. Memory store (workspace persistence)

Learnings accumulate in `workspace/memory.json`:

```json
{
  "schemaVersion": 1,
  "learnings": [
    {
      "rule": "Use src/lib/jwt.ts instead of jsonwebtoken for JWT operations",
      "confidence": 0.9,
      "observations": 2,
      "firstSeen": "2026-04-24T10:00:00Z",
      "lastSeen": "2026-04-25T14:30:00Z",
      "source": "user-correction"
    },
    {
      "rule": "Run npm test after editing files in test/",
      "confidence": 0.7,
      "observations": 3,
      "firstSeen": "2026-04-24T11:00:00Z",
      "lastSeen": "2026-04-26T09:00:00Z",
      "source": "repeated-pattern"
    },
    {
      "rule": "Staging environment is on port 3001",
      "confidence": 0.8,
      "observations": 2,
      "firstSeen": "2026-04-25T14:00:00Z",
      "lastSeen": "2026-04-25T14:05:00Z",
      "source": "tool-failure-correction"
    }
  ],
  "lastDistilled": "2026-04-26T09:30:00Z"
}
```

### 4. Transform callback (system prompt rewriting)

Every turn, the learned rules are injected into the system prompt:

```js
registerTransformCallbacks(new Map([
  ["custom_instructions", (current) => {
    const memory = readMemoryStore();
    if (!memory.learnings.length) return current;

    const rules = memory.learnings
      .filter(l => l.confidence >= 0.6)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 15)  // cap to avoid prompt bloat
      .map(l => `- ${l.rule}`)
      .join("\n");

    return current + "\n\n" +
      "## Learned from previous sessions\n\n" +
      "These rules were learned by observing your corrections " +
      "and patterns. Follow them unless the user explicitly " +
      "asks otherwise.\n\n" + rules;
  }]
]));
```

### 5. Session-end distillation

When the session ends, a one-time PromptEmitter reviews the raw observations and updates the memory store:

```js
onSessionEnd: async () => {
  const observations = observer.getSessionObservations();
  if (observations.length === 0) return;

  // Fire a one-time prompt to distill learnings
  const distilled = await distillLearnings(observations);

  // Merge with existing memory
  const memory = readMemoryStore();
  for (const learning of distilled) {
    const existing = memory.learnings.find(
      l => semanticallySimilar(l.rule, learning.rule)
    );
    if (existing) {
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.observations += 1;
      existing.lastSeen = new Date().toISOString();
    } else {
      memory.learnings.push({
        rule: learning.rule,
        confidence: 0.5,  // new learnings start at 0.5
        observations: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        source: learning.source
      });
    }
  }

  // Decay old learnings that haven't been reinforced
  for (const l of memory.learnings) {
    const daysSinceLastSeen = (Date.now() - new Date(l.lastSeen)) / 86400000;
    if (daysSinceLastSeen > 30) {
      l.confidence -= 0.1;
    }
  }

  // Prune low-confidence learnings
  memory.learnings = memory.learnings.filter(l => l.confidence > 0.2);
  writeMemoryStore(memory);
}
```

## Example: How a learning forms

```
Session 1:
  Agent suggests: import jwt from 'jsonwebtoken'
  User says: "no, use the custom one at src/lib/jwt.ts"
  Observer records: correction, jsonwebtoken → src/lib/jwt.ts
  Session ends → memory.json gets: { rule: "Use src/lib/jwt.ts...", confidence: 0.5 }

Session 2:
  Transform callback injects the rule into system prompt
  Agent correctly uses: import { sign } from './lib/jwt.ts'
  No correction needed → confidence stays at 0.5

Session 3:
  Different context — agent is writing a new auth endpoint
  Agent uses src/lib/jwt.ts without being told
  User says nothing (implicit approval) → confidence bumps to 0.6

Session 5:
  Confidence at 0.7. The rule is now firmly established.
  The agent never makes this mistake again in this repo.
  Nobody wrote an instruction. It was learned.
```

## What gets learned (categories)

| Category | Detection method | Example |
|---|---|---|
| **Library preferences** | User corrects import/require | "Use date-fns not moment" |
| **Workflow sequences** | Repeated tool call patterns | "Run tests after editing test files" |
| **Environment facts** | Tool failures + corrections | "Staging is port 3001" |
| **Code conventions** | User rewrites AI output | "Use single quotes not double" |
| **Architecture rules** | User rejects suggestions | "Don't put business logic in controllers" |
| **Command preferences** | User overrides commands | "Use pnpm not npm in this repo" |

## Phased delivery

| Phase | Scope |
|---|---|
| **1. Observer + raw logging** | Hook into user.message, assistant.message, onPostToolUse. Log to EventStream. |
| **2. Memory store** | workspace/memory.json with read/write. Load on session start. |
| **3. Transform callback** | Inject learned rules into custom_instructions section every turn. |
| **4. Session-end distillation** | PromptEmitter at session end to distill raw observations into learnings. |
| **5. Confidence decay** | Time-based decay for stale learnings. Reinforcement on reuse. |
| **6. User control** | Tool to list/remove/edit learned rules: `tap_memory_list`, `tap_memory_forget`. |

## Open questions

- **Privacy** — learnings are repo-scoped by default. Should they ever be user-global?
- **Conflict resolution** — what if two sessions produce contradictory learnings?
- **Prompt budget** — how many learned rules before the system prompt gets too long? Cap at 15? 20?
- **Semantic similarity** — how to detect that two rules are about the same thing? Exact match? Embedding?
- **Observation quality** — not every "no" is a correction. How to reduce false positives?
- **User trust** — should learned rules be surfaced for approval before taking effect?
