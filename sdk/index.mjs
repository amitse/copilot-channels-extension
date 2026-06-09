/**
 * ※ tap Provider SDK
 *
 * Build providers in ~20 lines instead of ~200. Handles:
 *   - Token discovery (env var + token file)
 *   - Gateway connection + auth + hello handshake
 *   - Automatic reconnection with backoff
 *   - Tool call dispatch
 *   - Push (inject/surface/keep) to session
 *   - Session lifecycle (idle, shutdown)
 *   - Cancellation handling
 *   - Forward compatibility (ignore unknown message types)
 *
 * Usage:
 *   import { createProvider } from "tap-provider-sdk";
 *
 *   const provider = createProvider("my-provider", {
 *     tools: [
 *       { name: "greet", description: "Say hello", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
 *     ],
 *     onToolCall: async (toolName, args) => {
 *       return `Hello, ${args.name}!`;
 *     },
 *     onConnected: () => console.log("Ready!"),
 *   });
 *
 *   // Push events to the Copilot session
 *   provider.push("Something happened");                   // inject (interrupts agent)
 *   provider.surface("Background info");                   // surface (shows in timeline)
 *   provider.keep("Internal note");                        // keep (stored in stream only)
 */

import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROTOCOL_VERSION = 2;
const FATAL_ERRORS = new Set(["AUTH_FAILED", "UNSUPPORTED_VERSION"]);
const DEFAULT_RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 30000;

// ── Token discovery ─────────────────────────────────────────────────────

function discoverToken() {
  if (process.env.TAP_PROVIDER_TOKEN) return process.env.TAP_PROVIDER_TOKEN;
  const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  const tokenFile = path.join(copilotHome, "extensions", "tap", ".provider-token");
  try { return fs.readFileSync(tokenFile, "utf8").trim(); } catch { /* ignore */ }
  return null;
}

// ── Provider factory ────────────────────────────────────────────────────

/**
 * Create a provider that connects to the ※ tap gateway.
 *
 * @param {string} name - Provider name (unique per gateway)
 * @param {object} options
 * @param {Array} options.tools - Tool definitions (name, description, parameters)
 * @param {Function} options.onToolCall - async (toolName, args, context) => string|object — returns tool result
 * @param {Function} [options.onConnected] - Called when provider is bound to a session
 * @param {Function} [options.onDisconnected] - Called when connection drops
 * @param {Function} [options.onSessionIdle] - Called when session becomes idle
 * @param {Function} [options.onShutdown] - Called on session shutdown.pending
 * @param {Function} [options.onError] - Called on gateway errors
 * @param {string} [options.gatewayUrl] - Override gateway URL (default: ws://localhost:9400)
 * @param {string} [options.token] - Override token (default: auto-discover)
 * @param {string} [options.instance] - Instance ID for multi-instance providers
 * @param {object} [options.metadata] - Provider metadata (title, url, etc.)
 * @param {boolean} [options.autoConnect] - Connect immediately (default: true)
 * @param {boolean} [options.silent] - Suppress console output (default: false)
 * @returns {object} Provider API
 */
export function createProvider(name, options = {}) {
  const {
    tools = [],
    onToolCall,
    onConnected,
    onDisconnected,
    onSessionIdle,
    onShutdown,
    onError,
    gatewayUrl = process.env.TAP_GATEWAY_URL || "ws://localhost:9400",
    token: explicitToken,
    instance,
    metadata,
    autoConnect = true,
    silent = false,
  } = options;

  const token = explicitToken || discoverToken();
  if (!token) {
    const msg = "TAP_PROVIDER_TOKEN not set and token file not found";
    if (!silent) console.error(`[${name}] ${msg}`);
    throw new Error(msg);
  }

  let ws = null;
  let providerId = null;
  let sessionId = null;
  let connected = false;
  let reconnectMs = DEFAULT_RECONNECT_MS;
  let reconnectTimer = null;
  let destroyed = false;
  let reconnectToken = null;

  const log = silent ? () => {} : (...args) => console.log(`[${name}]`, ...args);
  const logError = silent ? () => {} : (...args) => console.error(`[${name}]`, ...args);

  // ── Connection ────────────────────────────────────────────────────────

  function connect() {
    if (destroyed) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    try { ws = new WebSocket(gatewayUrl); } catch (err) {
      logError("Connection failed:", err.message);
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      log("Connected to gateway");
      // Try reconnect token first, fall back to regular auth
      if (reconnectToken) {
        ws.send(JSON.stringify({ type: "auth", reconnectToken, name, instance }));
      } else {
        ws.send(JSON.stringify({ type: "auth", token }));
      }
    });

    ws.on("message", handleMessage);

    ws.on("close", () => {
      const wasConnected = connected;
      connected = false;
      providerId = null;
      if (wasConnected) {
        log("Disconnected");
        onDisconnected?.();
      }
      if (!destroyed) scheduleReconnect();
    });

    ws.on("error", (err) => {
      logError("WebSocket error:", err.message);
    });
  }

  function scheduleReconnect() {
    if (destroyed || reconnectTimer) return;
    log(`Reconnecting in ${reconnectMs / 1000}s...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectMs = Math.min(reconnectMs * 1.5, MAX_RECONNECT_MS);
      connect();
    }, reconnectMs);
  }

  // ── Message handling ──────────────────────────────────────────────────

  function handlePairingMessage(msg) {
    log("⚠️  Pairing requested:", msg.prompt || "Enter code in Copilot session");
  }

  function sendHelloForSession(session) {
    const hello = {
      type: "hello",
      name,
      protocolVersion: PROTOCOL_VERSION,
      session: session.id,
      tools,
    };
    if (instance) hello.instance = instance;
    if (metadata) hello.metadata = metadata;
    ws.send(JSON.stringify(hello));
  }

  function handleSessionsMessage(msg) {
    if (!msg.active || !msg.active.length) {
      log("No active sessions, waiting...");
      return;
    }
    sendHelloForSession(msg.active[0]);
  }

  function handleHelloAckMessage(msg) {
    providerId = msg.providerId;
    sessionId = truthyOrNull(msg.sessionId);
    reconnectToken = truthyOrNull(msg.reconnectToken);
    connected = true;
    reconnectMs = DEFAULT_RECONNECT_MS; // reset backoff
    log(`✅ Registered (providerId: ${providerId})`);
    if (tools.length > 0) log(`   Tools: ${tools.map((t) => t.name).join(", ")}`);
    notifyConnected();
  }

  function truthyOrNull(value) {
    if (value) {
      return value;
    }
    return null;
  }

  function notifyConnected() {
    if (onConnected) {
      onConnected({ providerId, sessionId });
    }
  }

  function sendToolResult(result) {
    ws.send(JSON.stringify(result));
  }

  function serializeToolResultData(data) {
    if (typeof data === "string") {
      return data;
    }
    return JSON.stringify(data, null, 2);
  }

  async function handleToolCallMessage(msg) {
    if (!onToolCall) {
      sendToolResult({
        type: "tool.result", id: msg.id,
        error: "No tool handler registered", errorCode: "INTERNAL",
      });
      return;
    }

    let result;
    try {
      const context = { callId: msg.id, sessionId: msg.sessionId, providerId };
      const data = await onToolCall(msg.tool, msg.args || {}, context);
      result = { type: "tool.result", id: msg.id, data: serializeToolResultData(data) };
    } catch (err) {
      result = { type: "tool.result", id: msg.id, error: err.message, errorCode: "INTERNAL" };
    }
    sendToolResult(result);
  }

  function handleToolCancelMessage(msg) {
    sendToolResult({
      type: "tool.result", id: msg.id,
      error: "Cancelled", errorCode: "CANCELLED",
    });
  }

  function handleIdleLifecycle() {
    if (onSessionIdle) {
      onSessionIdle();
    }
  }

  function handleShutdownLifecycle() {
    if (onShutdown) {
      onShutdown();
    }
    ws.send(JSON.stringify({ type: "goodbye", reason: "session ending" }));
    ws.close();
  }

  const LIFECYCLE_HANDLERS = new Map([
    ["idle", handleIdleLifecycle],
    ["shutdown.pending", handleShutdownLifecycle]
  ]);

  function handleSessionLifecycleMessage(msg) {
    const handler = LIFECYCLE_HANDLERS.get(msg.state);
    if (handler) {
      handler();
    }
  }

  function handleErrorMessage(msg) {
    logError(`❌ [${msg.code}]: ${msg.message}`);
    onError?.(msg.code, msg.message);
    if (FATAL_ERRORS.has(msg.code)) {
      reconnectToken = null; // invalidate
      ws.close();
    }
  }

  const MESSAGE_HANDLERS = new Map([
    ["auth.pairing", handlePairingMessage],
    ["sessions", handleSessionsMessage],
    ["hello.ack", handleHelloAckMessage],
    ["tool.call", handleToolCallMessage],
    ["tool.cancel", handleToolCancelMessage],
    ["session.lifecycle", handleSessionLifecycleMessage],
    ["error", handleErrorMessage]
  ]);

  async function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Unregistered message types are intentionally ignored for forward compatibility.
    const handler = MESSAGE_HANDLERS.get(msg.type);
    if (handler) {
      await handler(msg);
    }
  }

  // ── Push API ──────────────────────────────────────────────────────────

  function canPushEvent() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN && connected);
  }

  function buildPushMessage(level, event, opts = {}) {
    const msg = { type: "push", level, event };
    if (opts.stream) msg.stream = opts.stream;
    else msg.stream = name; // default stream = provider name
    if (opts.metadata) msg.metadata = opts.metadata;
    return msg;
  }

  function pushEvent(level, event, opts = {}) {
    if (!canPushEvent()) {
      log(`Push dropped (not connected): ${event.slice(0, 80)}`);
      return false;
    }
    ws.send(JSON.stringify(buildPushMessage(level, event, opts)));
    return true;
  }

  // ── Tool updates ──────────────────────────────────────────────────────

  function updateTools(newTools) {
    tools.length = 0;
    tools.push(...newTools);
    if (ws && ws.readyState === WebSocket.OPEN && connected) {
      ws.send(JSON.stringify({ type: "tools.update", tools: newTools }));
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  function disconnect() {
    destroyed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      try { ws.send(JSON.stringify({ type: "goodbye", reason: "provider stopping" })); } catch {}
      ws.close();
      ws = null;
    }
    connected = false;
  }

  // ── Public API ────────────────────────────────────────────────────────

  const api = {
    /** Push an event that interrupts the agent (inject level) */
    push: (event, opts) => pushEvent("inject", event, opts),

    /** Push an event that shows in the timeline (surface level) */
    surface: (event, opts) => pushEvent("surface", event, opts),

    /** Push an event stored in the stream only (keep level) */
    keep: (event, opts) => pushEvent("keep", event, opts),

    /** Push with explicit level */
    pushEvent,

    /** Update registered tools dynamically */
    updateTools,

    /** Gracefully disconnect */
    disconnect,

    /** Connect (if autoConnect was false) */
    connect,

    /** Whether the provider is connected and bound */
    get connected() { return connected; },

    /** The provider ID assigned by the gateway */
    get providerId() { return providerId; },

    /** The session ID we're bound to */
    get sessionId() { return sessionId; },

    /** The raw WebSocket (for advanced usage) */
    get ws() { return ws; },

    /** Provider name */
    name,
  };

  if (autoConnect) connect();

  return api;
}
