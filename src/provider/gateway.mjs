import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { GATEWAY_PORT, RELOAD_DEBOUNCE_MS, TOKEN_PREFIX, CONNECTION_STATE, TOOL_RESULT_ERROR } from "./consts.mjs";
import { createProviderRegistry } from "./registry.mjs";
import { createProviderConnection } from "./connection.mjs";
import { computeTransition, identifyActions, GATEWAY_EVENT, GATEWAY_ACTION } from "./gateway-state.mjs";

function createDefaultTimerAdapter() {
  return {
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(timerId) {
      clearTimeout(timerId);
    }
  };
}

function createDefaultWebSocketAdapter() {
  return {
    connect() {
      return () => {};
    },
    send() {},
    close() {}
  };
}

export function createProviderGateway(options = {}, adapters = {}) {
  const {
    tapTools,
    getSessionInfo,
    log = () => {}
  } = options;

  const timerAdapter = adapters.timerAdapter ?? createDefaultTimerAdapter();
  const websocketAdapter = adapters.websocketAdapter ?? createDefaultWebSocketAdapter();

  const registry = createProviderRegistry();
  const connectionsByWs = new Map();
  const connectionsByProviderId = new Map();

  let wss = null;
  let token = null;
  let running = false;
  let toolsChangedCallback = null;
  let reloadTimer = null;
  let reloadPending = false;

  function generateToken() {
    token = TOKEN_PREFIX + randomBytes(16).toString("hex");
    process.env.TAP_PROVIDER_TOKEN = token;
    return token;
  }

  function getActiveSessions() {
    if (typeof getSessionInfo !== "function") return [];
    const info = getSessionInfo();
    return info ? [info] : [];
  }

  function scheduleReload() {
    const transition = computeTransition(
      { running, reloadPending, reloadTimerActive: Boolean(reloadTimer), token },
      { type: GATEWAY_EVENT.SCHEDULE_RELOAD, delayMs: RELOAD_DEBOUNCE_MS }
    );
    reloadPending = transition.nextState.reloadPending;
    for (const action of identifyActions(transition)) {
      if (action.type === GATEWAY_ACTION.SCHEDULE_TIMER) {
        if (reloadTimer) {
          timerAdapter.cancel(reloadTimer);
        }
        reloadTimer = timerAdapter.schedule(() => {
          reloadTimer = null;
          reloadPending = false;
          if (toolsChangedCallback && running) {
            const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
            const merged = registry.buildSessionTools(currentTapTools, dispatchToolCall);
            toolsChangedCallback(merged);
          }
        }, action.delayMs);
      }
    }
  }

  function onBound(conn) {
    connectionsByProviderId.set(conn.providerId, conn);
    try {
      registry.register(conn.providerId, conn.providerName, conn.tools, conn.sessionId);
    } catch (err) {
      log(`Failed to register provider '${conn.providerName}': ${err.message}`);
      conn.close();
      return;
    }

    const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
    const tapToolNames = new Set(currentTapTools.map((t) => t.name));
    const conflicts = registry.hasToolConflict(conn.tools, tapToolNames);
    if (conflicts.length > 0) {
      log(`Provider '${conn.providerName}' (${conn.providerId}) has tool conflicts with tap tools: ${conflicts.join(", ")}`);
    }

    scheduleReload();
    log(`Provider '${conn.providerName}' (${conn.providerId}) bound with ${conn.tools.length} tools`);
  }

  function onUnbound(conn) {
    connectionsByProviderId.delete(conn.providerId);
    registry.unregister(conn.providerId);
    scheduleReload();
    log(`Provider '${conn.providerName}' (${conn.providerId}) disconnected`);
  }

  function checkToolConflict(newTools) {
    const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
    const existingNames = new Set(currentTapTools.map((t) => t.name));
    for (const name of registry.getAllToolNames()) {
      existingNames.add(name);
    }
    return registry.hasToolConflict(newTools, existingNames);
  }

  function handleConnection(ws) {
    const conn = createProviderConnection(ws, {
      expectedToken: token,
      activeSessions: getActiveSessions(),
      onBound,
      onUnbound,
      onToolResult: () => {},
      checkToolConflict,
      log
    }, { websocketAdapter });

    connectionsByWs.set(ws, conn);

    ws.on("close", () => {
      connectionsByWs.delete(ws);
      if (conn.providerId) {
        connectionsByProviderId.delete(conn.providerId);
      }
    });

    ws.on("error", (err) => {
      log(`WebSocket error for provider '${conn.providerName || "unknown"}': ${err.message}`);
      connectionsByWs.delete(ws);
      if (conn.providerId) {
        connectionsByProviderId.delete(conn.providerId);
      }
    });
  }

  function start() {
    if (running) return;
    generateToken();

    try {
      wss = new WebSocketServer({ port: GATEWAY_PORT, noServer: false });

      wss.on("error", (err) => {
        log(`Provider gateway server error: ${err.message}`);
      });

      wss.on("connection", handleConnection);
      wss.on("listening", () => {
        log(`Provider gateway listening on port ${GATEWAY_PORT}`);
      });

      running = true;
    } catch (err) {
      log(`Failed to start provider gateway on port ${GATEWAY_PORT}: ${err.message}`);
      wss = null;
    }
  }

  function stop() {
    if (reloadTimer) {
      timerAdapter.cancel(reloadTimer);
      reloadTimer = null;
    }
    reloadPending = false;

    toolsChangedCallback = null;

    for (const conn of connectionsByWs.values()) {
      try { conn.close(); } catch { /* ignore */ }
    }
    connectionsByWs.clear();
    connectionsByProviderId.clear();

    if (wss) {
      wss.close();
      wss = null;
    }

    running = false;
    delete process.env.TAP_PROVIDER_TOKEN;
  }

  function getToken() {
    return token;
  }

  function getRegistry() {
    return registry;
  }

  function getAllTools(currentTapTools) {
    const tap = currentTapTools || (typeof tapTools === "function" ? tapTools() : []);
    return registry.buildSessionTools(tap, dispatchToolCall);
  }

  function dispatchToolCall(providerId, toolName, callId, args) {
    const conn = connectionsByProviderId.get(providerId);
    if (!conn || conn.state === CONNECTION_STATE.DISCONNECTED) {
      return Promise.resolve({
        error: `Provider '${providerId}' is disconnected`,
        errorCode: TOOL_RESULT_ERROR.DISCONNECTED
      });
    }
    return conn.sendToolCall(callId, conn.sessionId, toolName, args);
  }

  function broadcastLifecycle(sessionId, state, deadline) {
    for (const conn of connectionsByProviderId.values()) {
      if (conn.state === CONNECTION_STATE.BOUND) {
        try {
          conn.sendLifecycle(sessionId, state, deadline);
        } catch (err) {
          log(`Failed to send lifecycle to provider '${conn.providerName}': ${err.message}`);
        }
      }
    }
  }

  function onToolsChanged(callback) {
    toolsChangedCallback = callback;
  }

  function isRunning() {
    return running;
  }

  return {
    start,
    stop,
    getToken,
    getRegistry,
    getAllTools,
    dispatchToolCall,
    broadcastLifecycle,
    onToolsChanged,
    isRunning
  };
}
