# Copilot Instructions for ※ tap

## Build, validate, and deploy

```bash
npm run check          # Syntax check (fast, run after every change)
npm run build          # Bundle extension.mjs + copy artifacts to dist/
npm run install:local  # Build and force reinstall locally
npm run evals:smoke    # Smoke test — verifies the extension loads and tools are visible
npm run evals:run      # Full eval suite
```

### After editing source files

Always rebuild, reinstall, and reload the extension for changes to take effect:

```bash
npm run install:local
```

Then call `extensions_reload` to pick up the new code in the running session. Note: reloading generates a new `TAP_PROVIDER_TOKEN`, so any running providers will get `AUTH_FAILED` and need restarting.

### Publishing

**"Publish" means `git push` to main.** Do not run `npm publish` manually. GitHub Actions auto-publishes when the version changes.

## Project structure

Source lives in `src/`. Build outputs go to `dist/`. `.github/` is only for workflows.

- `src/extension.mjs` — Extension entry point (bundled into `dist/extension.mjs`)
- `src/tap-runtime.mjs` — Runtime factory that wires all subsystems together
- `src/copilot-instructions.md` — User-facing agent instructions (installed to `~/.copilot/`)
- `src/provider/gateway.mjs` — Provider WebSocket gateway
- `src/provider/connection.mjs` — Provider connection state machine
- `src/provider/registry.mjs` — Provider tool registry
- `bin/install.mjs` — CLI installer (fresh install vs update, `--full` to force)
- `providers/` — External provider implementations (e.g., `providers/detour/`)

## Sibling projects

### Detour (`E:\detour\`)

Detour is a **Chromium extension** for HTTP redirect and script injection during local development. It lives in `E:\detour\` (repo: `amitse/detour`).

Key facts:
- MV3 extension with `chrome.scripting.executeScript` for CSP-bypassing script injection
- Has "Inject on load" script rules that fetch external JS and inject it into matching pages
- The `providers/detour/` provider in this repo creates a tokenized bridge script URL (`http://127.0.0.1:9401/bridge.js?token=...`) that Detour injects into pages
- **Do not modify Detour's source** when building tap integrations — write injectable scripts instead

### Detour provider dev cycle

The full cycle for developing the bridge script (`providers/detour/`):

```bash
cd providers/detour
npm run build                # Bundle src/ → dist/bridge.js
```

Then restart the provider (kill old process first to avoid EADDRINUSE):

```powershell
# Kill old process on port 9401
$c = Get-NetTCPConnection -LocalPort 9401 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force; Start-Sleep 1 }

# Start provider
node index.mjs
```

Then copy the fresh tokenized bridge URL printed by the provider into Detour and reload the browser page so Detour injects the fresh `bridge.js`.

### esbuild settings for detour provider

For development/debugging, use these settings in `scripts/build.mjs`:
- `minify: false` — readable output
- `keepNames: true` — preserve function/variable names (esbuild renames even without minify)
- `sourcemap: "inline"` — DevTools shows original source files

## Key conventions

### COPILOT_HOME

The config directory is determined by `COPILOT_HOME` env var, falling back to `~/.copilot`. Never hardcode `~/.copilot`:

```js
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
```

### Provider token discovery

The gateway writes the token to `~/.copilot/extensions/tap/.provider-token` on startup and removes it on shutdown. External providers should read from this file as a fallback when `TAP_PROVIDER_TOKEN` env var is not set:

```js
const tokenFile = path.join(copilotHome, "extensions", "tap", ".provider-token");
try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch {}
```

### PromptEmitters use `session.send()`, not `session.sendAndWait()`

Prompt emitters dispatch prompts fire-and-forget via `session.send()`. Using `sendAndWait()` causes the response to appear twice.

### Provider → session communication

Providers **cannot** post directly to tap event streams. This is a common mistake — do not try to HTTP POST to the gateway WebSocket port.

To surface provider events in the Copilot session, use a **tap command emitter** that polls the provider's HTTP API:

1. Expose an HTTP endpoint on the provider (e.g., `GET /messages?ack=N`)
2. Start a tap command emitter that polls it every 2 seconds
3. Set `notifyPattern` to inject matching lines into the session
4. Use `delivery: "all"` with the pattern to control what gets injected

The emitter must be set up **every session** — it's not automatic. When the agent starts working with a provider, always check if the emitter exists and create it if not.

### Injected UI on arbitrary pages — no Shadow DOM

When injecting UI into arbitrary web pages (via Detour or similar), **do not use Shadow DOM**. Complex web apps (M365, GitHub) have aggressive event handlers that break Shadow DOM interaction — clicks don't fire, focus gets stolen, events get swallowed.

Instead:
- Use regular DOM with **prefixed CSS classes** (e.g., `__dp-panel`, `__dp-btn`)
- Apply `all: initial !important` on root elements to reset inherited styles
- Use **event delegation** with a single click handler + `data-action` attributes
- Add `stopPropagation()` in **capture phase** on the panel container for `click`, `mousedown`, `pointerdown`, `keydown`

## Windows / PowerShell gotchas

When running complex inline JS or JSON payloads via `node -e` or `curl` in PowerShell, escaping breaks on nested quotes, braces, and special characters. **Write a temporary `.cjs` file and run it with `node` instead.** Clean up after.
