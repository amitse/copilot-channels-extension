# Real-Copilot eval infrastructure

This folder is for **end-to-end evals with a real Copilot CLI session**, not mocked tool tests.

The goal is to answer:

- does Copilot discover and use the extension correctly?
- does it choose the right work shape: command monitor, command loop, prompt once, or prompt loop?
- does it handle subscriptions, classifiers, and persistence well?
- does it respect `managedBy="user"` boundaries?
- does it tighten classifiers only after it has seen real stream data?

## Source of truth

- `evals/cases.yaml` is the case catalog
- this file describes how to run and score the cases

## What is under test

The current extension surface includes:

- continuous command monitors
- looped command work via `every`
- one-shot prompt work
- prompt loops via `prompt` + `every`
- channel subscriptions
- per-line classifier checks for running scripts
- per-line classifier checks for prompt responses after they are split into lines
- persistent config behavior
- user-controlled vs model-controlled ownership

## Test philosophy

These evals should feel like **real user requests** to Copilot, not direct API fixture calls.

Each case should test whether Copilot:

1. understands the user's intent
2. picks the right extension tool(s)
3. picks the right work shape
4. starts broad enough to learn the stream
5. tightens filtering only after observing output
6. avoids overriding user-owned persistent state without explicit permission

## Recommended environment

Run each eval in a fresh Copilot CLI session with:

- authenticated GitHub Copilot CLI
- this repo as the current working directory
- repo-scoped extension loaded with `/clear` or `extensions_reload`
- a clean or intentionally prepared `copilot-channels.config.json`
- transcript capture enabled if possible

Recommended local context:

- OS: Windows (primary) plus one macOS/Linux spot check
- GitHub auth present for any `gh`-based cases
- Node available for `examples/heartbeat.mjs`

## Run model

Each eval should be driven by a natural-language user prompt from `cases.yaml`.

Suggested run loop:

1. Open a fresh Copilot CLI session in this repo.
2. Ensure the extension is loaded.
3. Prepare any case-specific setup from the YAML.
4. Paste the `user_prompt`.
5. Let Copilot work normally.
6. Capture:
   - tool calls
   - resulting channel history
   - monitor list output
   - config diffs if persistence is involved
   - whether the assistant respected ownership rules
7. Score the case.

## Scoring rubric

Use a simple 0-2 score per dimension:

- **0** = failed
- **1** = partially correct
- **2** = correct

Dimensions:

1. **Intent match** — chose the right extension feature
2. **Work shape** — correct choice of command vs prompt vs loop
3. **Filter strategy** — did not over-constrain too early
4. **Ownership safety** — respected `managedBy="user"`
5. **Persistence choice** — chose temporary vs persistent appropriately
6. **Operational quality** — clean stop, useful channel naming, sensible subscription mode

## Minimum evidence per case

Record these for every run:

- case ID
- Copilot model/version if visible
- OS
- user prompt
- actual tool calls
- final monitor state
- final channel state
- pass/fail notes

## Pass criteria

A case passes when:

- Copilot uses the extension in the intended way
- output is routed into the expected channel
- line-level behavior matches the case expectation
- filters remain absent until explicitly added, where relevant
- loops or persistence behave as requested

## Important behavioral checks

These are regression-sensitive and should be checked often:

### 1. No hidden notify fallback

When no `notifyPattern` exists, the system should not apply a secret built-in regex. A subscribed stream should remain unfiltered until a `notifyPattern` is introduced.

### 2. Line granularity

For running commands:

- stdout is processed line-by-line
- stderr is processed line-by-line

For prompt work:

- the assistant response is split into lines
- each line is evaluated independently by the classifier

### 3. Loop semantics

Current loop behavior is intentionally simple:

- `every` creates a fixed interval loop
- the next run is scheduled after the current run completes
- there is no cron parser beyond `30s`, `5m`, `2h`, `1d`, and `every 5 minutes` style strings
- there is no catch-up for missed intervals
- loops are session-scoped, though persistent config recreates them on the next session

### 4. Ownership semantics

Persistent, user-owned resources should require explicit override intent before Copilot changes them.

## Suggested fixture usage

Use these built-in repo assets first:

- `examples/heartbeat.mjs` for streaming command tests
- `copilot-channels.config.example.json` as a seed for persistence tests

If a case needs a more specific line pattern, add a small dedicated fixture script under `evals/fixtures/` later rather than relying on ad hoc shell one-liners.

## Future harness ideas

Once the case list stabilizes, the next step can be:

- a lightweight runner that materializes per-case setup
- transcript capture and result bundling
- golden pass/fail snapshots
- nightly or pre-release eval sweeps against real Copilot
