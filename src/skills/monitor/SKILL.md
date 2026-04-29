---
name: monitor
description: "Start a self-tuning command monitor. Use when the user says 'monitor', 'watch', 'tail', 'track', 'keep an eye on', or wants a shell command to run continuously while Copilot automatically reviews and tunes the output filters over time."
argument-hint: "<shell-command>"
user-invocable: true
---

Start a CommandEmitter for the given shell command paired with a companion PromptEmitter that periodically reads the stream and dynamically updates the filter expressions with `tap_set_event_filter`.

## Expected input

The entire invocation is the shell command to run continuously.

Example:

```text
/monitor tail -f /var/log/app.log
```

means:

- `command = "tail -f /var/log/app.log"`

If the command is missing, ask the user for it instead of guessing.

## What to create

### 1. CommandEmitter — the live command stream

Use `tap_start_emitter` to start the CommandEmitter:

- `command` — the user's shell command.
- No `every` field — commands default to continuous (always running).
- Initial `notifyPattern` — derive a sensible starting pattern from the command context (e.g. `error|warn|fail|exception` for log tailing, or omit entirely and let the companion tune it on first review).
- `subscribe = true`, `delivery = "important"` — injected lines reach the session.
- `scope = "temporary"`, `managedBy = "modelOwned"` (unless the user asked for persistence).
- Name the emitter concisely after the command (e.g. `app-logs`, `docker-mycontainer`).
- The EventStream is created automatically with the same name.

### 2. Companion PromptEmitter — the periodic filter reviewer

Use `tap_start_emitter` to start a second emitter immediately after the command emitter:

- `prompt` — a **fully self-contained** instruction (see template below).
- `everySchedule: ["10s", "20s", "30s", "1m", "2m", "5m", "10m"]` — backoff schedule: reviews start very frequent to validate the monitor quickly, then space out as it stabilises.
- `scope = "temporary"`, `managedBy = "modelOwned"`.
- Name it `<command-emitter-name>-review`.
- `subscribe = false` — review is internal housekeeping, not user-facing.
- `maxRuns` is optional. Only set it if the user explicitly requests a limit.

### Companion prompt template

Write the companion prompt so it stands alone — it must reference the command emitter and stream by their exact names, because the companion runs independently with no surrounding context. Use this structure:

```
Review the event stream for the '<command-emitter-name>' monitor and update its filters if needed.

Steps:
1. Call tap_stream_history for stream '<stream-name>' (limit 50).
2. If there are fewer than 5 entries, stop — not enough data to judge patterns yet.
3. Scan the recent lines for recurring patterns:
   - Lines that are always noise (timestamps-only, heartbeats, blank pings) → candidates for excludePattern.
   - Lines that indicate important events (errors, warnings, state changes) → candidates for notifyPattern.
   - Lines that are never relevant at all → candidates for tighter includePattern.
4. Compare what you see against the current filter patterns for emitter '<command-emitter-name>'.
5. Only update if the evidence clearly justifies a change (signal-to-noise is poor or a pattern is clearly wrong).
6. If an update is needed, call tap_set_event_filter with the revised patterns for emitter '<command-emitter-name>'.
7. Do not report your findings to the user unless you made a change. If you made a change, send one short message describing what you updated and why.
```

Substitute the real emitter name and stream name into the prompt before passing it to `tap_start_emitter`.

## Required behavior

When this skill is invoked:

1. Parse the command from the invocation.
2. Start the CommandEmitter.
3. Start the companion PromptEmitter using the self-contained prompt template and the hardcoded backoff schedule.
4. Confirm to the user:
   - Command emitter name and stream.
   - Initial filter patterns (or "none set — companion will tune on first review").
   - Companion reviewer name and its review schedule (first check in 10s, backing off to 10m).
5. Stop there — do not immediately inspect stream history or simulate a review.

## Stopping the monitor

To stop monitoring, both emitters must be stopped:

```
tap_stop_emitter '<command-emitter-name>'
tap_stop_emitter '<command-emitter-name>-review'
```

If the user asks to stop monitoring, stop both in a single response.

## Persistence

If the user explicitly asks to keep the monitor across sessions, set `scope = "persistent"` on **both** emitters. Say that both will be restored from config on the next session start.

## Conservative filter updates

Remind the companion (via the prompt) to be conservative:

- Update only when there is clear evidence from at least 5 recent entries (the same minimum checked inside the companion prompt).
- Prefer broadening `notifyPattern` over narrowing it — missing a real event is worse than an extra notification.
- Never remove `notifyPattern` entirely unless the stream is provably silent.
- Do not change `includePattern` or `excludePattern` on every review cycle — only when a pattern is clearly wrong.

## If the input is incomplete

If the invocation contains no recognisable shell command, ask the user for it.
