import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import {
  GATEWAY_PORT,
  RELOAD_DEBOUNCE_MS,
  TOKEN_PREFIX,
  ERROR_CODE,
  CONNECTION_STATE,
  TOOL_RESULT_ERROR,
  SESSION_LIFECYCLE_STATE
} from "./consts.mjs";
import { createProviderRegistry } from "./registry.mjs";
import { createProviderConnection } from "./connection.mjs";
import { computeTransition, identifyActions, GATEWAY_EVENT, GATEWAY_ACTION } from "./gateway-state.mjs";
import { createDefaultTimerAdapter } from "../util/timer-adapter.mjs";
import { ConflictError } from "../errors/index.mjs";

const DEFAULT_PROVIDER_HOST = "127.0.0.1";

function createDefaultWebSocketServer(options) {
  return new WebSocketServer(options);
}

function createDefaultFsAdapter() {
  return {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    chmodSync: (...args) => fs.chmodSync(...args),
    rmSync: (...args) => fs.rmSync(...args)
  };
}

function createDefaultPathAdapter() {
  return {
    join: (...parts) => path.join(...parts)
  };
}

function formatGatewayBindMessage(err, { host, port }) {
  const message = String(err?.message ?? err ?? "unknown error");
  const code = String(err?.code ?? "");
  const isPortInUse = code === "EADDRINUSE" || /\bEADDRINUSE\b|address already in use/i.test(message);

  if (!isPortInUse) {
    return `Provider gateway could not start on ${host}:${port}: ${message}`;
  }
  return [
    `Provider gateway mesh already has an owner at ${host}:${port}; this tap session is joining without binding another listener.`,
    "Core tap tools remain available.",
    "External providers should keep using the existing gateway.",
    "No action is needed unless provider tools are missing."
  ].join(" ");
}

export function createProviderGateway(options = {}, adapters = {}) {
  const {
    tapTools,
    getSessionInfo,
    deliverPush,
    log = () => {},
    host = DEFAULT_PROVIDER_HOST
  } = options;

  const timerAdapter = adapters.timerAdapter ?? createDefaultTimerAdapter();
  const hasCustomWebSocketAdapter = adapters.websocketAdapter != null;
  const websocketAdapter = hasCustomWebSocketAdapter ? adapters.websocketAdapter : null;
  const webSocketServerFactory = adapters.webSocketServerFactory ?? createDefaultWebSocketServer;
  const fsAdapter = adapters.fsAdapter ?? createDefaultFsAdapter();
  const pathAdapter = adapters.pathAdapter ?? createDefaultPathAdapter();
  const environment = adapters.environment ?? process.env;
  const homeDirectory = adapters.homeDirectory ?? (() => os.homedir());

  const registry = createProviderRegistry();
  const connectionsByWs = new Map();
  const connectionsByProviderId = new Map();

  let wss = null;
  let token = null;
  let running = false;
  let starting = false;
  let toolsChangedCallback = null;
  let reloadTimer = null;
  let reloadPending = false;
  let providerTokenFilePath = null;
  let shutdownTimer = null;
  let gracefulShutdownActive = false;

  function generateToken() {
    return TOKEN_PREFIX + randomBytes(16).toString("hex");
  }

  function getActiveSessions() {
    if (typeof getSessionInfo !== "function") return [];
    const info = getSessionInfo();
    return info ? [info] : [];
  }

  function getGatewayState() {
    return { running, reloadPending, reloadTimerActive: Boolean(reloadTimer), token };
  }

  function applyGatewayState(nextState) {
    if (!nextState) return;
    running = Boolean(nextState.running);
    reloadPending = Boolean(nextState.reloadPending);
    token = nextState.token ?? null;
  }

  function resolveProviderTokenPaths() {
    const copilotHome = environment.COPILOT_HOME || pathAdapter.join(homeDirectory(), ".copilot");
    const tokenDir = pathAdapter.join(copilotHome, "extensions", "tap");
    return {
      tokenDir,
      tokenFile: pathAdapter.join(tokenDir, ".provider-token")
    };
  }

  function writeProviderTokenFile(nextToken) {
    let paths;
    try {
      paths = resolveProviderTokenPaths();
      providerTokenFilePath = paths.tokenFile;
      fsAdapter.mkdirSync(paths.tokenDir, { recursive: true, mode: 0o700 });
      fsAdapter.writeFileSync(paths.tokenFile, `${nextToken}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      log(`Failed to write provider token file: ${err.message}`);
      return;
    }

    try {
      fsAdapter.chmodSync?.(paths.tokenFile, 0o600);
    } catch (err) {
      log(`Failed to restrict provider token file permissions: ${err.message}`);
    }
  }

  function removeProviderTokenFile() {
    const tokenFile = providerTokenFilePath;
    if (!tokenFile) {
      return;
    }
    try {
      fsAdapter.rmSync(tokenFile, { force: true });
    } catch (err) {
      log(`Failed to remove provider token file: ${err.message}`);
    } finally {
      providerTokenFilePath = null;
    }
  }

  function setToken(nextToken) {
    if (!nextToken) {
      clearToken();
      return;
    }
    token = nextToken ?? null;
    environment.TAP_PROVIDER_TOKEN = token;
    writeProviderTokenFile(token);
  }

  function clearToken() {
    token = null;
    delete environment.TAP_PROVIDER_TOKEN;
    removeProviderTokenFile();
  }

  function cancelReloadTimer() {
    if (reloadTimer) {
      timerAdapter.cancel(reloadTimer);
      reloadTimer = null;
    }
  }

  function cancelShutdownTimer() {
    if (shutdownTimer) {
      timerAdapter.cancel(shutdownTimer);
      shutdownTimer = null;
    }
    gracefulShutdownActive = false;
  }

  function closeProviderConnections(reason = "gateway stopped") {
    const connections = [...new Set(connectionsByWs.values())];
    for (const conn of connections) {
      try { conn.close(reason); } catch { /* ignore */ }
    }
    connectionsByWs.clear();
    connectionsByProviderId.clear();
  }

  function finishGracefulShutdown(reason = "shutdown deadline reached") {
    shutdownTimer = null;
    gracefulShutdownActive = false;
    closeProviderConnections(reason);
  }

  function beginGracefulShutdown(deadlineMs) {
    if (typeof deadlineMs !== "number" || deadlineMs <= 0 || !Number.isFinite(deadlineMs)) {
      return;
    }
    if (connectionsByWs.size === 0) {
      return;
    }
    cancelShutdownTimer();
    gracefulShutdownActive = true;
    shutdownTimer = timerAdapter.schedule(() => {
      finishGracefulShutdown("shutdown deadline reached");
    }, deadlineMs);
  }

  function maybeCancelGracefulShutdownWhenDrained() {
    if (gracefulShutdownActive && connectionsByWs.size === 0) {
      cancelShutdownTimer();
    }
  }

  function refreshTools() {
    reloadTimer = null;
    if (toolsChangedCallback && running) {
      const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
      const merged = registry.buildSessionTools(currentTapTools, dispatchToolCall);
      toolsChangedCallback(merged);
    }
  }

  function executeGatewayAction(action) {
    switch (action.type) {
      case GATEWAY_ACTION.SET_TOKEN:
        setToken(action.token);
        return;
      case GATEWAY_ACTION.CLEAR_TOKEN:
        clearToken();
        return;
      case GATEWAY_ACTION.SET_RUNNING:
        running = Boolean(action.value);
        return;
      case GATEWAY_ACTION.CANCEL_TIMER:
        cancelReloadTimer();
        return;
      case GATEWAY_ACTION.SCHEDULE_TIMER:
        cancelReloadTimer();
        reloadTimer = timerAdapter.schedule(() => {
          applyGatewayTransition({ type: GATEWAY_EVENT.RELOAD_FIRED });
        }, action.delayMs);
        return;
      case GATEWAY_ACTION.REFRESH_TOOLS:
        refreshTools();
        return;
      default:
        return;
    }
  }

  function applyGatewayTransition(event) {
    const transition = computeTransition(getGatewayState(), event);
    applyGatewayState(transition.nextState);
    for (const action of identifyActions(transition)) {
      executeGatewayAction(action);
    }
    return transition;
  }

  function scheduleReload() {
    applyGatewayTransition({ type: GATEWAY_EVENT.SCHEDULE_RELOAD, delayMs: RELOAD_DEBOUNCE_MS });
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

  function checkToolConflict(newTools, excludedProviderId = null) {
    const currentTapTools = typeof tapTools === "function" ? tapTools() : [];
    const existingNames = new Set(currentTapTools.map((t) => t.name));
    for (const name of registry.getAllToolNames({ excludedProviderId })) {
      existingNames.add(name);
    }
    return registry.hasToolConflict(newTools, existingNames);
  }

  function onPush(conn, push) {
    if (typeof deliverPush !== "function") {
      log(`Provider '${conn.providerName}' (${conn.providerId}) pushed '${push.level}' but no delivery adapter is registered`);
      return;
    }

    deliverPush({
      providerId: conn.providerId,
      providerName: conn.providerName,
      sessionId: conn.sessionId
    }, push);
  }

  function onToolsUpdate(conn, update) {
    const conflicts = checkToolConflict(update.tools, conn.providerId);
    if (conflicts.length > 0) {
      throw new ConflictError(`tool name conflict: ${conflicts.join(", ")}`, {
        code: ERROR_CODE.TOOL_CONFLICT,
        context: {
          providerId: conn.providerId,
          providerName: conn.providerName,
          sessionId: conn.sessionId,
          conflicts: conflicts.join(", ")
        }
      });
    }

    registry.updateTools(conn.providerId, update.tools);
    scheduleReload();
    log(`Provider '${conn.providerName}' (${conn.providerId}) updated tools: ${update.tools.length}`);
  }

  function handleConnection(ws) {
    const connectionAdapters = hasCustomWebSocketAdapter ? { websocketAdapter } : {};
    const conn = createProviderConnection(ws, {
      expectedToken: token,
      activeSessions: getActiveSessions(),
      onBound,
      onUnbound,
      onPush,
      onToolsUpdate,
      onToolResult: () => {},
      checkToolConflict,
      log
    }, connectionAdapters);

    connectionsByWs.set(ws, conn);

    ws.on("close", () => {
      connectionsByWs.delete(ws);
      if (conn.providerId) {
        connectionsByProviderId.delete(conn.providerId);
      }
      maybeCancelGracefulShutdownWhenDrained();
    });

    ws.on("error", (err) => {
      log(`WebSocket error for provider '${conn.providerName || "unknown"}': ${err.message}`);
      connectionsByWs.delete(ws);
      if (conn.providerId) {
        connectionsByProviderId.delete(conn.providerId);
      }
      maybeCancelGracefulShutdownWhenDrained();
    });
  }

  function closeServer(server) {
    if (!server) return;
    try {
      server.close();
    } catch {
      // Best-effort cleanup only.
    }
  }

  function resetFailedStart(server, err) {
    log(formatGatewayBindMessage(err, { host, port: GATEWAY_PORT }));
    starting = false;
    if (wss === server) {
      wss = null;
    }
    closeServer(server);
    applyGatewayTransition({ type: GATEWAY_EVENT.STOP });
  }

  function start() {
    if (running || starting) return;
    cancelShutdownTimer();
    closeProviderConnections("gateway restarting");
    const nextToken = generateToken();
    let server = null;

    try {
      starting = true;
      let listened = false;
      server = webSocketServerFactory({ port: GATEWAY_PORT, host, noServer: false });
      wss = server;

      server.on("error", (err) => {
        if (wss !== server) {
          return;
        }
        if (!listened) {
          resetFailedStart(server, err);
          return;
        }
        log(`Provider gateway server error: ${err.message}`);
      });

      server.on("connection", handleConnection);
      server.on("listening", () => {
        if (wss !== server) {
          return;
        }
        listened = true;
        starting = false;
        applyGatewayTransition({ type: GATEWAY_EVENT.START, token: nextToken });
        log(`Provider gateway listening on port ${GATEWAY_PORT}`);
      });
    } catch (err) {
      resetFailedStart(server, err);
    }
  }

  function stop() {
    starting = false;
    const keepConnectionsUntilShutdownDeadline = gracefulShutdownActive && connectionsByWs.size > 0;
    applyGatewayTransition({ type: GATEWAY_EVENT.STOP });

    // Preserve toolsChangedCallback across cached runtime stop/start cycles;
    // tap-runtime registers it once when the runtime is first created.
    if (wss) {
      closeServer(wss);
      wss = null;
    }

    if (keepConnectionsUntilShutdownDeadline) {
      maybeCancelGracefulShutdownWhenDrained();
      return;
    }

    cancelShutdownTimer();
    closeProviderConnections("gateway stopped");
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

  function projectProviderTool(tool) {
    return {
      name: tool.name,
      description: tool.description ?? "",
      timeout: tool.timeout ?? null
    };
  }

  function getDiagnosticState() {
    const connections = [...connectionsByProviderId.values()];
    return {
      running,
      starting,
      host,
      port: GATEWAY_PORT,
      reloadPending,
      reloadTimerActive: Boolean(reloadTimer),
      tokenPresent: Boolean(token),
      providerTokenFilePath: providerTokenFilePath ? "[redacted]" : null,
      gracefulShutdownActive,
      connectionCount: connectionsByWs.size,
      boundConnectionCount: connections.filter((conn) => conn.state === CONNECTION_STATE.BOUND).length,
      providers: registry.listProviders().map((provider) => {
        const conn = connectionsByProviderId.get(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          sessionId: provider.sessionId,
          state: conn?.state ?? "unknown",
          pendingCallCount: conn?.pendingCallCount ?? 0,
          toolCount: provider.tools.length,
          tools: provider.tools.map(projectProviderTool)
        };
      })
    };
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
    if (state === SESSION_LIFECYCLE_STATE.SHUTDOWN_PENDING) {
      beginGracefulShutdown(deadline);
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
    getDiagnosticState,
    dispatchToolCall,
    broadcastLifecycle,
    onToolsChanged,
    isRunning
  };
}
