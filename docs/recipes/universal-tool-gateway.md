# Recipe: Universal Tool Gateway — Dynamic Capabilities via Script Injection

## The insight

Detour injects arbitrary JS into any web page. `session.registerTools()` adds tools to Copilot at runtime. Combine them: **any script, in any environment, can expose capabilities to Copilot dynamically.**

Instead of building separate extensions with hardcoded tools, tap becomes a **runtime tool gateway**. Connected clients announce tool definitions over WebSocket, tap materializes them in the Copilot session. When clients disconnect, their tools vanish.

## Architecture

```
                        ┌─────────────────────────────┐
                        │  Copilot CLI session         │
                        │                             │
                        │  ※ tap (tool gateway)        │
                        │  session.registerTools(...)  │
                        └──────────┬──────────────────┘
                                   │ ws
                        ┌──────────▼──────────────────┐
                        │  Bridge Server               │
                        │  ws://localhost:9400          │
                        └──┬──────┬──────┬──────┬─────┘
                           │      │      │      │
                    ┌──────▼┐ ┌───▼───┐ ┌▼────┐ ┌▼──────────┐
                    │Browser│ │Electron│ │Node │ │Any process │
                    │(Detour)│ │ app   │ │script│ │with WS    │
                    └───────┘ └───────┘ └─────┘ └───────────┘
```

Every connected client is just a script that:
1. Opens a WebSocket to the bridge
2. Sends a `hello` with its tool definitions
3. Handles tool invocations when Copilot calls them
4. Optionally pushes events (→ tap emitter → Copilot session)

## How tool definitions travel over the wire

### Client announces capabilities

```json
{
  "type": "hello",
  "role": "provider",
  "name": "my-app",
  "tools": [
    {
      "name": "app_get_user",
      "description": "Get the currently logged-in user from the app",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    },
    {
      "name": "app_search",
      "description": "Search the app's data",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        },
        "required": ["query"]
      }
    }
  ]
}
```

### tap materializes tools in Copilot

When a provider connects, tap:
1. Reads the tool definitions from the `hello` message
2. Creates handler functions that route calls through the bridge
3. Calls `session.registerTools([...existingTools, ...newTools])`
4. Copilot immediately sees the new tools

When a provider disconnects, tap re-registers without those tools.

### Copilot calls a dynamic tool

```
User: "who is logged in?"

Copilot calls: app_get_user({})
  → tap routes to bridge
    → bridge routes to "my-app" provider
      → provider executes, returns { user: "alice" }
    → bridge routes response back
  → tap returns result to Copilot

Copilot: "The logged-in user is alice."
```

## What this enables

### Browser pages (via Detour)

Inject a bridge client script into any web page. The script announces tools based on what's available in that page's context.

```js
// Injected into a React app — announces React-specific tools
bridge.announce({
  tools: [
    { name: "react_component_tree", description: "Get the React component tree" },
    { name: "react_state", description: "Read React state for a component" },
    { name: "page_screenshot", description: "Screenshot the viewport" }
  ]
});
```

### Electron / desktop apps

Any Electron app can include a bridge client. Copilot gets tools to read app state, trigger actions, inspect UI.

### Internal tools and dashboards

Inject a bridge client into your company's admin dashboard. Copilot can now query production data, check deployment status, read monitoring dashboards — all through dynamically registered tools.

### CI/CD and DevOps

A bridge client in your CI pipeline announces build/deploy tools. Copilot can trigger deploys, check build status, read test results.

### Other terminal processes

A Node script or Python process connects to the bridge and exposes domain-specific tools. A data pipeline announces query tools. A test runner announces result inspection tools.

## Protocol

### Messages

| Type | Direction | Purpose |
|---|---|---|
| `hello` | provider → bridge | Announce name + tool definitions |
| `tools.update` | provider → bridge | Update tool definitions (add/remove) |
| `tool.call` | bridge → provider | Copilot invoked a tool, execute it |
| `tool.result` | provider → bridge | Return tool execution result |
| `push` | provider → bridge | Unsolicited event (→ tap emitter) |
| `goodbye` | provider → bridge | Graceful disconnect, remove tools |

### Tool call flow

```
Copilot → tap handler → bridge.request("tool.call", { provider, tool, args })
  → bridge routes to provider
  → provider executes
  → provider sends tool.result
  → bridge routes back
  → tap handler returns result to Copilot
```

## The bridge client SDK

A tiny JS module (~50 lines) that any script includes to become a provider:

```js
import { createBridgeClient } from "copilot-bridge-client";

const bridge = createBridgeClient({
  url: "ws://localhost:9400",
  name: "my-app"
});

bridge.tool("get_user", "Get the current user", {}, async () => {
  return { user: getCurrentUser() };
});

bridge.tool("search", "Search data", {
  query: { type: "string" }
}, async ({ query }) => {
  return await searchDatabase(query);
});

bridge.connect();
```

That's it. Copilot now has `get_user` and `search` tools.

## Implications

1. **Extensions become optional.** Instead of packaging tools into a Copilot extension, any running process can expose tools dynamically.
2. **Capabilities are composable.** Open a React app in Chrome → React tools appear. Start a deploy script → deploy tools appear. Tools come and go based on what's running.
3. **Skills become injectable.** A provider can also send context/instructions along with tools, giving Copilot domain knowledge about how to use them.
4. **tap becomes a tool multiplexer.** Its core job shifts from "emitter runtime" to "dynamic tool gateway that routes between Copilot and any connected service."

## Relationship to MCP

This is the inverse of MCP (Model Context Protocol):
- **MCP**: Copilot connects to external servers that expose tools
- **Bridge**: External services connect to Copilot (via tap) and expose tools

The bridge pattern is more dynamic — tools appear and disappear based on runtime state. And the provider can be anything that runs JS (browser tab, Electron, Node, etc.) with zero infrastructure beyond the bridge relay.

## Phased delivery

| Phase | Scope |
|---|---|
| **1. Bridge server + protocol** | WebSocket relay, hello/tool.call/tool.result messages |
| **2. tap integration** | Dynamic registerTools on provider connect/disconnect |
| **3. Bridge client SDK** | Tiny JS module for providers to include |
| **4. Detour recipe** | Example: inject bridge client into a web page via Detour |
| **5. Push events** | Provider → tap emitter pipeline for unsolicited events |
| **6. Context injection** | Providers send instructions/context alongside tools |
