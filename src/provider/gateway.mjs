import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { GATEWAY_PORT, RELOAD_DEBOUNCE_MS, TOKEN_PREFIX, CONNECTION_STATE, TOOL_RESULT_ERROR } from "./consts.mjs";
import { createProviderRegistry } from "./registry.mjs";
import { createProviderConnection } from "./connection.mjs";

export function createProviderGateway(options = {}) {
  const {
    sessionPort,
    tapTools,
    getSessionInfo,
    log = () => {},
  } = options;

  const registry = createProviderRegistry();

  // connection tracking
  const connectionsByWs = new Map();
  const connectionsByProviderId = new Map();

  let wss = null;
  let token = null;
  let running = false;
  let toolsChangedCallback = null;
  let reloadTimer = null;

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  function generateToken() {
    token = TOKEN_PREFIX + randomBytes(16).toString("hex");
    process.env.TAP_PROVIDER_TOKEN = token;
    return token;
  }

  // -------------------------------------------------------------------------
  // Debounced reload
  // -------------------------------------------------------------------------

  function scheduleReload() {
    if (!running) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (toolsChangedCallback) {
        const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
        const merged = registry.buildSessionTools(currentTapTools, dispatchToolCall);
        toolsChangedCallback(merged);
      }
    }, RELOAD_DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Active sessions helper
  // -------------------------------------------------------------------------

  function getActiveSessions() {
    if (typeof getSessionInfo !== "function") return [];
    const info = getSessionInfo();
    return info ? [info] : [];
  }

  // -------------------------------------------------------------------------
  // Connection callbacks
  // -------------------------------------------------------------------------

  function onBound(conn) {
    connectionsByProviderId.set(conn.providerId, conn);
    try {
      registry.register(conn.providerId, conn.providerName, conn.tools, conn.sessionId);
    } catch (err) {
      log(`Failed to register provider '${conn.providerName}': ${err.message}`);
      conn.close();
      return;
    }

    // Check tool conflicts against tap tools and other providers
    const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
    const tapToolNames = new Set(currentTapTools.map(t => t.name));
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
    const existingNames = new Set(currentTapTools.map(t => t.name));
    // Also include tools from other providers
    for (const name of registry.getAllToolNames()) {
      existingNames.add(name);
    }
    return registry.hasToolConflict(newTools, existingNames);
  }

  // -------------------------------------------------------------------------
  // WebSocket server
  // -------------------------------------------------------------------------

  function handleConnection(ws) {
    const conn = createProviderConnection(ws, {
      expectedToken: token,
      activeSessions: getActiveSessions(),
      onBound,
      onUnbound,
      onToolResult: () => {},
      checkToolConflict,
      log,
    });

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

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start() {
    if (running) return;
    generateToken();

    try {
      wss = new WebSocketServer({ port: GATEWAY_PORT, noServer: false });

      // Attach error listener BEFORE the server starts listening
      // to prevent unhandled 'error' events from crashing the process.
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
      return;
    }
  }

  function stop() {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }

    // Disable callback before closing to prevent reload scheduling during shutdown
    const savedCallback = toolsChangedCallback;
    toolsChangedCallback = null;

    // Close all provider connections
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
        errorCode: TOOL_RESULT_ERROR.DISCONNECTED,
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
    isRunning,
  };
}
