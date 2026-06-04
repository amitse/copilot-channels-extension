import { randomBytes } from "node:crypto";

import {
  CONNECTION_STATE,
  MESSAGE_TYPE,
  ERROR_CODE,
  PAYLOAD_LIMIT,
  PROTOCOL_VERSION,
  TOOL_RESULT_ERROR,
  FATAL_ERROR_CODES,
} from "./consts.mjs";

import {
  parseMessage,
  validateAuth,
  validateHello,
  validateToolResult,
  validateGoodbye,
  buildSessions,
  buildHelloAck,
  buildToolCall,
  buildToolCancel,
  buildSessionLifecycle,
  buildError,
} from "./protocol.mjs";
import {
  AppError,
  ConflictError,
  LifecycleError,
  NotFoundError,
  ValidationError
} from "../errors/index.mjs";
import { mapErrorToResponse } from "../errors/handler.mjs";

// Provider→Gateway message types we know how to handle
const PROVIDER_MESSAGE_TYPES = new Set([
  MESSAGE_TYPE.AUTH,
  MESSAGE_TYPE.HELLO,
  MESSAGE_TYPE.TOOL_RESULT,
  MESSAGE_TYPE.GOODBYE,
]);

function generateProviderId() {
  return "p-" + randomBytes(4).toString("hex");
}

/**
 * @typedef {Object} ProviderConnectionOptions
 * @property {string} expectedToken - Token for authentication
 * @property {Array} activeSessions - List of available sessions for binding
 * @property {Function} [onBound] - Callback when provider successfully binds (called with connection)
 * @property {Function} [onUnbound] - Callback when provider disconnects (called with connection)
 * @property {Function} [onToolResult] - Callback when tool result received (called with connection, result)
 * @property {Function} [checkToolConflict] - Callback to check tool name conflicts (called with tools array)
 * @property {Function} [log] - Logging function (default: no-op)
 */

/**
 * Create a per-connection state machine that manages a single WebSocket
 * connection from a provider.
 * 
 * Minimal interface: all parameters are capabilities that drive state machine behavior.
 * Only what's needed for this connection lifecycle is injected.
 * @param {WebSocket} ws - WebSocket connection
 * @param {ProviderConnectionOptions} options
 */
export function createProviderConnection(ws, options) {
  const {
    expectedToken,
    activeSessions,
    onBound,
    onUnbound,
    onToolResult,
    checkToolConflict,
    log = () => {},
  } = options;

  let state = CONNECTION_STATE.AWAIT_AUTH;
  let providerId = null;
  let providerName = null;
  let sessionId = null;
  let tools = [];
  let wasBound = false;

  // Map<callId, { resolve, reject, timer }>
  const pendingCalls = new Map();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function send(msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log(`[connection] send failed: ${err.message}`);
    }
  }

  function sendError(errorOrCode, message, opts = {}) {
    if (errorOrCode instanceof AppError || errorOrCode instanceof Error) {
      const mapped = mapErrorToResponse(errorOrCode);
      if (mapped.diagnostics.context && Object.keys(mapped.diagnostics.context).length > 0) {
        log(`[connection] ${mapped.diagnostics.name}: ${mapped.diagnostics.code} ${JSON.stringify(mapped.diagnostics.context)}`);
      }
      send(buildError(mapped.error.code, mapped.response.error.message, opts));
      return;
    }

    send(buildError(errorOrCode, message, opts));
  }

  function fatalError(errorOrCode, message, opts = {}) {
    sendError(errorOrCode, message, opts);
    transition(CONNECTION_STATE.DISCONNECTED);
    try { ws.close(); } catch { /* ignore */ }
  }

  function transition(next) {
    const prev = state;
    state = next;
    log(`[connection] ${providerId ?? "?"}: ${prev} → ${next}`);
  }

  function rejectAllPending(reason) {
    for (const [callId, entry] of pendingCalls) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new LifecycleError(reason ?? "provider disconnected", {
        code: TOOL_RESULT_ERROR.DISCONNECTED,
        context: { callId, providerId },
        retryable: false
      }));
    }
    pendingCalls.clear();
  }

  // -------------------------------------------------------------------------
  // State handlers
  // -------------------------------------------------------------------------

  function handleAwaitAuth(msg) {
    if (msg.type !== MESSAGE_TYPE.AUTH) {
      sendError(new ValidationError(`expected auth, got "${msg.type}"`, {
        code: ERROR_CODE.UNKNOWN_TYPE,
        context: { state, receivedType: msg.type }
      }));
      return;
    }

    const v = validateAuth(msg);
    if (!v.ok) {
      fatalError(new ValidationError(v.error, {
        code: ERROR_CODE.AUTH_FAILED,
        context: { state, receivedType: msg.type },
        retryable: false
      }));
      return;
    }

    if (v.token !== expectedToken) {
      fatalError(new ValidationError("invalid token", {
        code: ERROR_CODE.AUTH_FAILED,
        context: { state, receivedType: msg.type },
        retryable: false
      }));
      return;
    }

    // Auth succeeded — send sessions list and advance
    send(buildSessions(activeSessions));
    transition(CONNECTION_STATE.AWAIT_HELLO);
  }

  function handleAwaitHello(msg) {
    if (msg.type !== MESSAGE_TYPE.HELLO) {
      sendError(new ValidationError(`expected hello, got "${msg.type}"`, {
        code: ERROR_CODE.UNKNOWN_TYPE,
        context: { state, receivedType: msg.type }
      }));
      return;
    }

    const v = validateHello(msg);
    if (!v.ok) {
      const code = v.code ?? ERROR_CODE.UNKNOWN_TYPE;
      if (FATAL_ERROR_CODES.includes(code)) {
        fatalError(new ValidationError(v.error, { code, context: { state, receivedType: msg.type } }));
      } else {
        sendError(new ValidationError(v.error, { code, context: { state, receivedType: msg.type } }));
      }
      return;
    }

    const hello = v.hello;

    // Validate session exists in activeSessions
    const sessionMatch = activeSessions.find((s) => s.id === hello.session);
    if (!sessionMatch) {
      sendError(new NotFoundError(`unknown session: ${hello.session}`, {
        code: ERROR_CODE.INVALID_SESSION,
        context: { session: hello.session, state }
      }));
      return;
    }

    // Check tool conflicts if callback provided
    if (checkToolConflict && hello.tools.length > 0) {
      const conflicts = checkToolConflict(hello.tools);
      if (conflicts && conflicts.length > 0) {
        sendError(new ConflictError(`tool name conflict: ${conflicts.join(", ")}`, {
          code: ERROR_CODE.TOOL_CONFLICT,
          context: { conflicts, state }
        }));
        return;
      }
    }

    // Bind successfully
    providerId = generateProviderId();
    providerName = hello.name;
    sessionId = hello.session;
    tools = hello.tools;

    send(buildHelloAck(PROTOCOL_VERSION, providerId));
    transition(CONNECTION_STATE.BOUND);
    wasBound = true;

    if (onBound) {
      try { onBound(connection); } catch (err) {
        log(`[connection] onBound callback error: ${err.message}`);
      }
    }
  }

  function handleBound(msg) {
    if (msg.type === MESSAGE_TYPE.TOOL_RESULT) {
      const v = validateToolResult(msg);
      if (!v.ok) {
        sendError(new ValidationError(v.error, {
          code: ERROR_CODE.UNKNOWN_TYPE,
          context: { providerId, sessionId, replyTo: msg.id }
        }), undefined, {
          replyTo: msg.id,
          providerId,
          sessionId,
        });
        return;
      }

      const result = v.result;
      const pending = pendingCalls.get(result.id);

      if (pending) {
        // First terminal result wins; remove from pending
        if (pending.timer) clearTimeout(pending.timer);
        pendingCalls.delete(result.id);

        if (result.error) {
          const errorContext = {
            providerId,
            providerName,
            sessionId,
            callId: result.id
          };
          if (result.errorCode === TOOL_RESULT_ERROR.NOT_FOUND) {
            pending.reject(new NotFoundError(result.error, {
              code: result.errorCode,
              context: errorContext
            }));
          } else if (result.errorCode === TOOL_RESULT_ERROR.TIMEOUT) {
            pending.reject(new AppError(result.error, {
              code: result.errorCode,
              context: errorContext,
              retryable: true
            }));
          } else if (result.errorCode === TOOL_RESULT_ERROR.DISCONNECTED || result.errorCode === TOOL_RESULT_ERROR.CANCELLED) {
            pending.reject(new LifecycleError(result.error, {
              code: result.errorCode,
              context: errorContext
            }));
          } else {
            pending.reject(new AppError(result.error, {
              code: result.errorCode ?? TOOL_RESULT_ERROR.INTERNAL,
              context: errorContext
            }));
          }
        } else {
          pending.resolve(result);
        }
      }
      // Duplicate results for unknown/already-resolved calls are silently ignored

      if (onToolResult) {
        try { onToolResult(connection, result); } catch (err) {
          log(`[connection] onToolResult callback error: ${err.message}`);
        }
      }
      return;
    }

    if (msg.type === MESSAGE_TYPE.GOODBYE) {
      const v = validateGoodbye(msg);
      if (!v.ok) {
        log(`[connection] invalid goodbye: ${v.error}`);
      }
      transition(CONNECTION_STATE.DISCONNECTED);
      rejectAllPending("provider sent goodbye");
      if (onUnbound) {
        try { onUnbound(connection); } catch (err) {
          log(`[connection] onUnbound callback error: ${err.message}`);
        }
      }
      try { ws.close(); } catch { /* ignore */ }
      return;
    }

    // Unknown provider→gateway type
    if (PROVIDER_MESSAGE_TYPES.has(msg.type)) {
      // Known type but invalid in Bound state (auth/hello)
      sendError(new ValidationError(`unexpected "${msg.type}" in Bound state`, {
        code: ERROR_CODE.UNKNOWN_TYPE,
        context: { state, receivedType: msg.type }
      }));
    } else {
      // Truly unknown type
      sendError(new ValidationError(`unknown message type: "${msg.type}"`, {
        code: ERROR_CODE.UNKNOWN_TYPE,
        context: { state, receivedType: msg.type }
      }));
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket event handlers
  // -------------------------------------------------------------------------

  function onMessage(raw) {
    if (state === CONNECTION_STATE.DISCONNECTED) return;

    // Use larger limit for tool.result in Bound state
    const limit = state === CONNECTION_STATE.BOUND
      ? PAYLOAD_LIMIT.TOOL_RESULT
      : PAYLOAD_LIMIT.DEFAULT;

    const parsed = parseMessage(raw, limit);
    if (!parsed.ok) {
      const code = parsed.code === "PAYLOAD_TOO_LARGE"
        ? ERROR_CODE.PAYLOAD_TOO_LARGE
        : ERROR_CODE.INVALID_JSON;
      sendError(new ValidationError(parsed.error, {
        code,
        context: { state }
      }));
      return;
    }

    const msg = parsed.message;

    switch (state) {
      case CONNECTION_STATE.AWAIT_AUTH:
        handleAwaitAuth(msg);
        break;
      case CONNECTION_STATE.AWAIT_HELLO:
        handleAwaitHello(msg);
        break;
      case CONNECTION_STATE.BOUND:
        handleBound(msg);
        break;
      default:
        break;
    }
  }

  function onClose() {
    if (state === CONNECTION_STATE.DISCONNECTED) return;
    const wasPreviouslyBound = wasBound;
    transition(CONNECTION_STATE.DISCONNECTED);
    rejectAllPending("WebSocket closed");
    if (wasPreviouslyBound && onUnbound) {
      try { onUnbound(connection); } catch (err) {
        log(`[connection] onUnbound callback error: ${err.message}`);
      }
    }
  }

  function onError(err) {
    log(`[connection] WebSocket error: ${err.message}`);
    if (state === CONNECTION_STATE.DISCONNECTED) return;
    const wasPreviouslyBound = wasBound;
    transition(CONNECTION_STATE.DISCONNECTED);
    rejectAllPending(`WebSocket error: ${err.message}`);
    if (wasPreviouslyBound && onUnbound) {
      try { onUnbound(connection); } catch (err2) {
        log(`[connection] onUnbound callback error: ${err2.message}`);
      }
    }
  }

  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("error", onError);

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function sendToolCallMsg(callId, targetSessionId, toolName, args) {
    if (state !== CONNECTION_STATE.BOUND) {
      return Promise.reject(new LifecycleError("connection not in Bound state", {
        code: TOOL_RESULT_ERROR.DISCONNECTED,
        context: { state },
        retryable: false
      }));
    }

    return new Promise((resolve, reject) => {
      pendingCalls.set(callId, { resolve, reject, timer: null });
      send(buildToolCall(callId, targetSessionId, toolName, args));
    });
  }

  function sendToolCancelMsg(callId, targetSessionId, reason) {
    if (state !== CONNECTION_STATE.BOUND) return;
    send(buildToolCancel(callId, targetSessionId, reason));
  }

  function sendLifecycle(targetSessionId, lifecycleState, deadline) {
    if (state !== CONNECTION_STATE.BOUND) return;
    send(buildSessionLifecycle(targetSessionId, lifecycleState, deadline));
  }

  function close(reason) {
    if (state === CONNECTION_STATE.DISCONNECTED) return;
    const wasPreviouslyBound = wasBound;
    transition(CONNECTION_STATE.DISCONNECTED);
    rejectAllPending(reason ?? "connection closed by gateway");
    if (wasPreviouslyBound && onUnbound) {
      try { onUnbound(connection); } catch (err) {
        log(`[connection] onUnbound callback error: ${err.message}`);
      }
    }
    try { ws.close(); } catch { /* ignore */ }
  }

  const connection = {
    get state() { return state; },
    get providerId() { return providerId; },
    get providerName() { return providerName; },
    get sessionId() { return sessionId; },
    get tools() { return tools; },
    sendToolCall: sendToolCallMsg,
    sendToolCancel: sendToolCancelMsg,
    sendLifecycle,
    close,
  };

  return connection;
}
