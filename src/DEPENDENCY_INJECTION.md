# Capability-Specific Dependency Injection

This document describes the minimal dependency injection contracts across the emitter and tools layers. Each module now receives only the capabilities it needs, reducing coupling and improving testability.

## Design Principles

1. **Minimal interface**: Each module receives only the capabilities it uses
2. **Explicit contracts**: JSDoc typedef documents what each function needs
3. **No unused parameters**: If a module is passed a dependency, it must use it
4. **Capability-first**: Pass behavior (functions/callbacks) rather than objects when possible

## Dependency Contracts by Module

### emitter/supervisor.mjs

**Receives:** `SupervisorDeps`
```typescript
{
  streams: Object,           // Event stream manager (append, ensure, list)
  configStore: Object,       // Persistent emitter config (get/upsert/remove)
  notifications: Object,     // Notification dispatcher (enqueue)
  sessionPort: Object,       // Session logger (log)
  getBaseCwd: Function,      // Returns base working directory
  persist: Function          // Saves config to disk
}
```

**Usage:**
- `start()`: Uses all 6 (builds state, persists, notifies, logs)
- `stop()`: Uses configStore, sessionPort, persist (removes from config)
- `updateEventFilter()`: Uses configStore, sessionPort, persist
- `stopAll()`: Delegates to lifecycle (no direct deps used)
- `list()`, `has()`, `get()`: Use internal state only

**Why:** Supervisor orchestrates the full lifecycle. It needs all capabilities to build emitters, persist state, and handle creation/destruction.

---

### emitter/lifecycle.mjs

**Receives:** `LifecycleDeps`
```typescript
{
  lineRouter: Object,   // Line handler (appendSystemMessage, handleLine)
  sessionPort: Object   // Session logger + idle checker (log, isIdle)
}
```

**Usage:**
- `start()`: Uses lineRouter (via startContinuousProcess or startScheduled)
- `stop()`: Uses sessionPort (logs), lineRouter (logs completion)
- `onSessionIdle()`: Uses nothing directly (state-based guard)
- `onSessionActivity()`: Uses nothing directly (state-based guard)
- Internal helpers: runScheduledIteration, runPromptIteration all use these

**Why:** Lifecycle manages process execution and scheduling. It only needs to append messages and check session state.

---

### emitter/line-router.mjs

**Receives:** `LineRouterDeps`
```typescript
{
  streams: Object,         // Event stream manager (append, ensure)
  notifications: Object    // Notification dispatcher (enqueue)
}
```

**Usage:**
- `appendSystemMessage()`: Uses streams (append), notifications (enqueue if enabled)
- `handleLine()`: Uses streams (append), notifications (enqueue on INJECT)
- `handleTextBlock()`: Uses above via handleLine
- `handlePromptResult()`: Uses streams only (append)

**Why:** Line router processes emitter output and routes events. It doesn't need logging or session info—it delegates surfacing decisions to supervisor/lifecycle layers.

---

### provider/connection.mjs

**Receives:** `ProviderConnectionOptions`
```typescript
{
  expectedToken: string,                    // Auth token to validate
  activeSessions: Array,                    // Available session list
  onBound?: Function,                       // Callback: (connection) => void
  onUnbound?: Function,                     // Callback: (connection) => void
  onToolResult?: Function,                  // Callback: (connection, result) => void
  checkToolConflict?: Function,             // Callback: (tools) => conflictNames[]
  log?: Function                            // Default: no-op
}
```

**Usage by state:**
- `AWAIT_AUTH`: expectedToken, activeSessions, log
- `AWAIT_HELLO`: activeSessions, checkToolConflict, onBound, log
- `BOUND`: onToolResult, onUnbound, log
- Helper functions (send, fatalError, etc.): log

**Why:** Connection is a state machine. All parameters drive state transitions or callbacks. Different phases use different capabilities—this is intentional and correct.

---

### tools/monitors.mjs

**Receives:** `EmitterToolsDeps`
```typescript
{
  streams: Object,        // Event stream manager
  configStore: Object,    // Persistent config (for list only)
  supervisor: Object,     // Emitter supervisor
  getBaseCwd: Function    // Returns base working directory
}
```

**Usage:**
- `renderEmitterList()`: streams, configStore, supervisor
- `tap_list_emitters`: streams, configStore, supervisor (via helper)
- `tap_start_emitter`: supervisor, getBaseCwd, streams (logs to streams)
- `tap_set_event_filter`: supervisor only
- `tap_stop_emitter`: supervisor only

**Why:** Tool handlers are mostly wrappers. Most only need supervisor. The list handler is the only one that needs configStore. This is acceptable because it's internal to a single tool factory.

---

### tools/channels.mjs

**Receives:** `StreamToolsDeps` (full deps object)
```typescript
{
  streams: Object,        // Event stream manager
  configStore: Object,    // Persistent config
  sessionPort: Object,    // Session logger
  persist: Function       // Save config
}
```

**Usage by handler:**
- `tap_list_streams`: streams only
- `tap_post`: streams, sessionPort
- `tap_stream_history`: streams only
- `tap_enable_injector`: Full deps (via applySessionInjector)
- `tap_disable_injector`: Full deps (via applySessionInjector)

**Why:** The simple handlers (list, post, history) use minimal deps. The injector operations are cross-cutting and need full context (streams + config persistence + session logging). Accepting full deps here is pragmatic—the tool factory itself doesn't decompose handlers, and attempting to do so would over-engineer.

---

## Changes from Broad to Specific Injection

### Before
```javascript
// Supervisor received everything, lineRouter received everything
const lineRouter = createLineRouter({ streams, notifications, sessionPort });
const supervisor = createEmitterSupervisor({ 
  streams, configStore, notifications, sessionPort, getBaseCwd, persist 
});
```

### After
```javascript
// LineRouter receives only what it uses
const lineRouter = createLineRouter({ streams, notifications });
// Supervisor passes only needed deps to lineRouter
const supervisor = createEmitterSupervisor({ 
  streams, configStore, notifications, sessionPort, getBaseCwd, persist 
});
  // Inside supervisor:
  const lineRouter = createLineRouter({ streams, notifications });
  const lifecycle = createLifecycle({ lineRouter, sessionPort });
```

## Benefits

1. **Reduced coupling**: Each module's dependencies are explicit and minimal
2. **Better testability**: Mock/stub only what's needed, not entire dep bags
3. **Clearer contracts**: JSDoc typedef shows exactly what each function needs
4. **Reduced waste**: No passing dependencies that are never used
5. **Easier refactoring**: Changing a module's internals doesn't cascade

## Testing

When testing modules in isolation:

```javascript
// Test lineRouter without needing sessionPort
const mockRouter = createLineRouter({
  streams: mockStreams,
  notifications: mockNotifications
});

// Test lifecycle without needing configStore
const mockLifecycle = createLifecycle({
  lineRouter: mockRouter,
  sessionPort: mockSessionPort
});
```

## Future Improvements

1. Consider extracting handler groups in `channels.mjs` if the tool factory grows (tap_list_* vs tap_injector_*)
2. When adding new modules, start with minimal interface—add deps only when needed
3. Document all JSDoc typedef contracts for generated API docs
