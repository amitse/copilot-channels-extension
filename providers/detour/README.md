# ⚡ Detour — Browser ↔ Agent Bridge

Detour lets the Copilot agent inject JavaScript into any browser page and receive console logs back in real-time.

## How it works

```
┌─────────┐  ws://127.0.0.1:9401?token=...  ┌─────────────┐  ws://localhost:9400  ┌─────────┐
│ Browser  │◄────────────────────►│   Detour     │◄────────────────────►│ ※ tap    │
│ (page)   │  eval + console logs │  Provider    │  tool calls          │ Gateway  │
└─────────┘                       └─────────────┘                       └─────────┘
```

1. **Detour provider** runs locally — connects to tap gateway and serves a token-protected browser WebSocket
2. **Browser bridge** is injected by Detour — connects to Detour, hooks `console.*`, listens for eval commands
3. **Agent** calls `inject_js` / `get_console_logs` / `list_browser_clients` through tap

## Quick start

```bash
# 1. Install dependencies
cd providers/detour
npm install

# 2. Run the provider (grab token from your Copilot session)
#    PowerShell:
$env:TAP_PROVIDER_TOKEN = "<token>"; node index.mjs
#    Bash:
TAP_PROVIDER_TOKEN=<token> node index.mjs

# 3. Copy the printed Bridge URL into Detour's Inject on load rule.
```

The provider prints a URL like `http://127.0.0.1:9401/bridge.js?token=...`.
Use that exact URL so the injected bridge can authenticate to the local WebSocket.

You'll see **⚡ Detour connected** in the console. The agent now has 3 new tools:

## Tools

| Tool | Description |
|---|---|
| `inject_js` | Execute JS in the browser page context. Returns the result. Supports async (Promises). |
| `get_console_logs` | Retrieve captured console.log/warn/error/info/debug output. Filter by level or client. |
| `list_browser_clients` | List all connected browser tabs with URL, title, and client ID. |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TAP_PROVIDER_TOKEN` | (required) | Auth token from Copilot session |
| `TAP_GATEWAY_URL` | `ws://localhost:9400` | Gateway WebSocket URL |
| `DETOUR_PORT` | `9401` | Port for browser connections |
| `DETOUR_BRIDGE_TOKEN` | random per run | Optional fixed token for the browser bridge HTTP and WebSocket endpoints |

## Example agent usage

Once connected, the agent can:

```
Agent: "Let me check what's on the page"
→ calls inject_js({ code: "document.title" })
← "My Cool App"

Agent: "Let me look at the DOM structure"
→ calls inject_js({ code: "document.querySelector('main').innerHTML.slice(0, 1000)" })
← "<div class='hero'>..."

Agent: "Any errors on the page?"
→ calls get_console_logs({ level: "error" })
← [{ level: "error", args: ["Failed to fetch /api/users"], timestamp: "..." }]

Agent: "Let me fix that button"
→ calls inject_js({ code: "document.querySelector('#submit-btn').style.display = 'block'" })
← "block"
```

## Multiple pages

You can paste the snippet into multiple browser tabs. Each gets a unique client ID. Use `list_browser_clients` to see them, and pass `client_id` to target a specific tab.

## Security note

Detour binds its browser bridge to loopback and requires the printed bridge token for HTTP and WebSocket access. It still allows arbitrary JS execution on authenticated connected pages — use responsibly and only on pages you control.
