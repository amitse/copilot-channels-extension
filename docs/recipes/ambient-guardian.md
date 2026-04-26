# Recipe: Ambient Guardian — Continuous Background Intelligence

## The insight

Skills fire when invoked. tap fires when something happens. The gap between these two is **time** — the 30 seconds between a teammate's force-push and your next `git push` that will conflict. The 90 seconds between a deploy and the error spike it causes. The silent period while CI is failing and you're still writing code that depends on it passing.

The Ambient Guardian is a pattern where tap maintains a continuous awareness of your environment and interrupts **only when something needs your attention right now**. Not a dashboard. Not a notification system. A runtime that understands what you're doing and correlates it with what's happening around you.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Copilot CLI session                                      │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Ambient Guardian (tap extension layer)              │ │
│  │                                                     │ │
│  │  onPreToolUse ──► gate actions against live state    │ │
│  │  onPostToolUse ──► track what you're working on     │ │
│  │  transform callbacks ──► rewrite rules per context  │ │
│  └────────┬───────────┬───────────┬────────────────────┘ │
│           │           │           │                       │
│  ┌────────▼──┐ ┌──────▼───┐ ┌────▼──────┐               │
│  │ Emitter:  │ │ Emitter: │ │ Emitter:  │               │
│  │ git state │ │ CI watch │ │ env probe │               │
│  │ (30s poll)│ │ (gh api) │ │ (custom)  │               │
│  └────────┬──┘ └──────┬───┘ └────┬──────┘               │
│           │           │          │                        │
│  ┌────────▼───────────▼──────────▼──────┐                │
│  │  Correlation PromptEmitter (idle)     │                │
│  │  Reads all streams, finds patterns,   │                │
│  │  decides what to surface              │                │
│  └───────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

## Why skills can't do this

A skill can check CI status when you ask. But:

1. You don't ask until you're about to push — by then you've built on a broken foundation for 20 minutes.
2. A skill can't correlate a deploy, an error spike, and a PR comment that happened 90 seconds apart. It sees one thing at a time.
3. A skill can't physically block a `git push` mid-execution. `onPreToolUse` can.
4. A skill can't rewrite the system prompt to say "be conservative, production is degraded." Transform callbacks can.

The value is in what happens **between user messages** — the silence when nobody is asking questions but the world is changing.

## Components

### 1. Environment emitters (the eyes)

Three CommandEmitters running continuously:

**Git state watcher** — polls every 30 seconds:
```bash
git fetch --quiet 2>/dev/null; \
echo "branch=$(git branch --show-current)"; \
echo "ahead=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)"; \
echo "behind=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)"; \
echo "dirty=$(git status --porcelain | wc -l)"; \
echo "conflicts=$(git diff --name-only --diff-filter=U | wc -l)"
```

**CI watcher** — polls GitHub Actions:
```bash
gh run list --branch $(git branch --show-current) --limit 3 --json status,conclusion,name,createdAt
```

**Deploy/infra probe** — customizable per project (Kubernetes, AWS, Vercel, etc.):
```bash
kubectl get pods -l app=myservice --no-headers | awk '{print $1, $3, $4, $5}'
```

### 2. EventFilter rules (noise control)

```json
[
  { "match": "behind=0",          "outcome": "drop"    },
  { "match": "dirty=0",           "outcome": "drop"    },
  { "match": "conflicts=[1-9]",   "outcome": "inject"  },
  { "match": "behind=[1-9]",      "outcome": "surface" },
  { "match": "status.*failure",   "outcome": "inject"  },
  { "match": "CrashLoopBackOff",  "outcome": "inject"  },
  { "match": ".*",                "outcome": "keep"    }
]
```

Most polls produce nothing interesting → dropped. Only real signals break through.

### 3. Correlation engine (the brain)

A PromptEmitter on idle schedule that reads across all streams:

```
prompt: |
  You are a background correlation engine. Read the recent events
  from all streams and look for patterns:
  - Did something change in one stream that explains an event in another?
  - Is there a time correlation between events across streams?
  - Is the developer's current work going to collide with something
    that just happened?

  Only report if you find a genuine correlation. Say nothing if
  everything looks normal. Be terse — one sentence max.

  Stream history:
  {{git_stream_last_10}}
  {{ci_stream_last_10}}
  {{deploy_stream_last_10}}
```

### 4. Action gating (onPreToolUse)

Before tool calls execute, the guardian checks live state:

```js
onPreToolUse: async ({ toolName, toolArgs }) => {
  // Block push if CI is failing
  if (toolName === "shell" && isGitPush(toolArgs.command)) {
    const ciState = streams.latest("ci-watch");
    if (ciState?.includes("failure")) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "CI is currently failing on this branch. Fix the failing " +
          "tests before pushing, or the failure will block the PR."
      };
    }
  }

  // Warn before editing files that have upstream changes
  if (toolName === "edit") {
    const gitState = streams.latest("git-watch");
    if (gitState?.behind > 0) {
      return {
        additionalContext:
          `Warning: your branch is ${gitState.behind} commits behind ` +
          `origin. The file you're editing may have upstream changes. ` +
          `Consider pulling first.`
      };
    }
  }
}
```

### 5. Context-adaptive system prompt (transform callbacks)

```js
registerTransformCallbacks(new Map([
  ["code_change_rules", (current) => {
    const branch = streams.latest("git-watch")?.branch;
    const ciStatus = streams.latest("ci-watch")?.status;
    const deploying = streams.latest("deploy-watch")?.deploying;

    const additions = [];

    if (branch === "main" || branch === "master") {
      additions.push(
        "You are on the production branch. Require explicit user " +
        "confirmation before any file write. Suggest a feature branch."
      );
    }

    if (ciStatus === "failure") {
      additions.push(
        "CI is currently failing. Prioritize fixing tests over new features."
      );
    }

    if (deploying) {
      additions.push(
        "A production deploy is in progress. Do not suggest database " +
        "migrations or infrastructure changes until it completes."
      );
    }

    return additions.length > 0
      ? current + "\n\n" + additions.join("\n")
      : current;
  }]
]));
```

## Example scenarios

### Scenario A: The silent conflict

```
You're writing code on feature/auth (10 minutes in)
    │
    ▼
Git emitter detects: branch is now 2 commits behind origin
    │
    ▼
EventFilter: behind=[1-9] → surface
    │
    ▼
Timeline shows: "※ tap: feature/auth is 2 commits behind origin"
    │
    ▼
You keep working (it's just a surface, not an inject)
    │
    ▼
5 minutes later, you ask Copilot to edit src/auth.ts
    │
    ▼
onPreToolUse fires → checks git state → one of the upstream
  commits touched src/auth.ts
    │
    ▼
Copilot receives: "Warning: src/auth.ts was modified in an upstream
  commit (abc123 by Alice, 7 min ago). Your edit may conflict.
  Consider pulling first."
    │
    ▼
You pull, resolve cleanly, then continue. Saved 20 minutes of
  merge conflict debugging.
```

### Scenario B: The cascading failure

```
3 events arrive over 90 seconds:

  2:01pm — deploy emitter: "v2.4.2 deployed to prod"
  2:02pm — CI emitter: "staging pipeline failed: connection refused"
  2:03pm — deploy emitter: "pod auth-service restart count: 4"
    │
    ▼
Correlation PromptEmitter (idle) reads all streams:
    │
    ▼
Injects: "Deploy v2.4.2 is causing auth-service crash loops
  (4 restarts in 2 min). Staging CI is failing with connection
  refused — likely same root cause. Consider rolling back."
    │
    ▼
Meanwhile, transform callback has already added to system prompt:
  "Production is degraded. Do not suggest changes to auth-service
   configuration. Prioritize investigation and rollback."
    │
    ▼
You say: "rollback" — Copilot already knows the context,
  runs the rollback command immediately.
```

### Scenario C: The preemptive gate

```
You ask Copilot: "push my changes"
    │
    ▼
onPreToolUse fires for shell(git push)
    │
    ▼
Guardian checks:
  ✗ CI status: failure (test/auth.spec.ts)
  ✗ Uncommitted files: 2 files not in this branch's scope
  ✓ Branch: feature/auth (not main)
  ✓ No deploy in progress
    │
    ▼
Returns: permissionDecision: "deny"
  reason: "CI is failing on test/auth.spec.ts (your branch).
           Also, you have 2 uncommitted files (config.json,
           .env.local) that aren't related to this PR.
           Fix the test first, then stash or commit the
           unrelated files."
    │
    ▼
Copilot: "I can't push right now — CI is failing and you
  have unrelated uncommitted files. Want me to fix the
  failing test first?"
```

## Configuration

In `tap.config.json`:

```json
{
  "guardian": {
    "emitters": {
      "git": { "every": "30s", "enabled": true },
      "ci": { "every": "60s", "enabled": true },
      "deploy": { "command": "kubectl get pods ...", "every": "60s", "enabled": false }
    },
    "correlation": { "schedule": "idle", "enabled": true },
    "gating": {
      "blockPushOnCIFailure": true,
      "warnOnUpstreamChanges": true,
      "blockMainBranchWrites": true
    }
  }
}
```

## Phased delivery

| Phase | Scope |
|---|---|
| **1. Git + CI emitters** | Two CommandEmitters with EventFilter rules, surface/inject thresholds |
| **2. onPreToolUse gating** | Block push on CI failure, warn on upstream conflicts |
| **3. Transform callbacks** | Context-adaptive system prompt based on branch/CI/deploy state |
| **4. Correlation engine** | PromptEmitter that reads across streams and synthesizes |
| **5. Configuration** | Per-project guardian config in tap.config.json |

## Open questions

- **Polling frequency** — 30s for git, 60s for CI? Configurable per project?
- **Gate strictness** — deny vs. warn? Should the user be able to override gates?
- **Correlation prompt** — how to keep it cheap (token-wise) while effective?
- **Multi-repo** — does the guardian follow you across repos, or reset per project?
- **Override mechanism** — `--force` style escape hatch for gates?
