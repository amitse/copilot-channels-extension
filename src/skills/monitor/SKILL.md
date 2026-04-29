---
name: monitor
description: "Start a self-tuning command monitor. Use when the user says 'monitor', 'watch', 'tail', 'track', 'keep an eye on', or wants a shell command to run continuously while Copilot automatically reviews and tunes the output filters over time."
argument-hint: "[review-interval] <shell-command>"
user-invocable: true
---

Start a CommandEmitter for the given shell command paired with a companion PromptEmitter that periodically reads the stream and dynamically updates the filter expressions with `tap_set_event_filter`.

## Expected input

Interpret the invocation as:

1. An **optional** first argument that is the review interval for the companion (e.g. `5m`, `10m`, `1h`). Defaults to `5m` when omitted.
2. The rest of the input is the shell command to run continuously.

Example (with explicit interval):

```text
/monitor 10m tail -f /var/log/app.log
```

means:

- `reviewInterval = "10m"` — companion reviews the stream every 10 minutes
- `command = "tail -f /var/log/app.log"`

Example (default interval):

```text
/monitor docker logs -f mycontainer
```

means:

- `reviewInterval = "5m"` (default)
- `command = "docker logs -f mycontainer"`

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
- `every = <reviewInterval>` — timed schedule.
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

1. Parse the review interval and command from the invocation.
2. Start the CommandEmitter.
3. Start the companion PromptEmitter using the self-contained prompt template above.
4. Confirm to the user:
   - Command emitter name and stream.
   - Initial filter patterns (or "none set — companion will tune on first review").
   - Companion reviewer name and review interval.
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

If the review interval looks like part of the command (e.g. `/monitor tail -f …`), treat the first token as the command start and use the default interval `5m`.

If only an interval is given with no command, ask for the command.
