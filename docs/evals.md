# Evals

Testing infrastructure for copilot-tap-extension.

## Quick validation

```bash
npm run check              # syntax check
npm run evals:smoke        # smoke test
npm run evals:validate-modes  # interactive vs prompt-mode gap
```

## How the eval runner works

`evals/run.mjs` starts one ACP server, creates fresh SDK sessions, and mounts the shared runtime from `src/tap-runtime.mjs` directly into those sessions. This means `smoke` and `run` exercise the same EventStream/EventEmitter logic as the extension without depending on `.github/extensions` being discovered in a headless session.

The runner writes prompt, response, error, and full event-transcript artifacts under `evals/results/...`.

## Supported paths

The reliable supported paths are:

1. **Interactive foreground Copilot sessions**
2. **ACP/SDK sessions that mount the shared runtime directly**

Do **not** treat headless prompt-mode or other non-interactive repo-extension loading as reliable. Use `validate-modes` to prove that distinction.

## Extension-loader evals

The real repo-scoped extension loader is validated separately. `npm run evals:validate-modes` probes `copilot -p` with the actual `.github/extensions` entrypoint, then compares with the same prompt in an interactive session.

For interactive executor evals:

```bash
node evals/run.mjs prepare-interactive --case E001
# run the printed prompt inside an interactive `copilot` session
# then run the printed /share command
node evals/run.mjs judge-interactive --run-dir "<printed-run-dir>"
```

This keeps the executor in a foreground Copilot session where the extension can attach, uses `/share <path>` to persist the transcript, and runs a tool-free ACP judge against the transcript plus config snapshots. If you reuse one session for multiple cases, run `/clear` before each next case.
