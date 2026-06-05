import { randomBytes } from "node:crypto";

import {
  CONNECTION_STATE,
  MESSAGE_TYPE,
  ERROR_CODE,
  PAYLOAD_LIMIT,
  PROTOCOL_VERSION,
  TOOL_RESULT_ERROR
} from "./consts.mjs";
import {
  parseMessage,
  validateAuth,
  validateHello,
  validateToolResult,
  validateGoodbye,
  buildToolCall,
  buildToolCancel,
  buildSessionLifecycle,
  buildError
} from "./protocol.mjs";
import {
  AppError,
  ConflictError,
  LifecycleError,
  NotFoundError,
  TimeoutError,
  ValidationError
} from "../errors/index.mjs";
import { mapErrorToResponse } from "../errors/handler.mjs";
import { computeTransition, identifyActions, CONNECTION_ACTION, CONNECTION_EVENT } from "./connection-state.mjs";

function generateProviderId() {
  return "p-" + randomBytes(4).toString("hex");
}

function createDefaultWebSocketAdapter() {
  return {
    connect(ws, handlers) {
      ws.on("message", handlers.message);
      ws.on("close", handlers.close);
      ws.on("error", handlers.error);
      return () => {
        ws.off?.("message", handlers.message);
        ws.off?.("close", handlers.close);
        ws.off?.("error", handlers.error);
      };
    },
    send(ws, msg, callback) {
      ws.send(JSON.stringify(msg), callback);
    },
    close(ws) {
      ws.close();
    }
  };
}

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

export function createProviderConnection(ws, options, adapters = {}) {
  const {
    expectedToken,
    activeSessions,
    onBound,
    onUnbound,
    onToolResult,
    checkToolConflict,
    log = () => {}
  } = options;

  const websocketAdapter = adapters.websocketAdapter ?? createDefaultWebSocketAdapter();
  const timerAdapter = adapters.timerAdapter ?? createDefaultTimerAdapter();

  let state = CONNECTION_STATE.AWAIT_AUTH;
  let providerId = null;
  let providerName = null;
  let sessionId = null;
  let tools = [];
  let wasBound = false;

  const pendingCalls = new Map();

  function send(msg, onFailure) {
    try {
      websocketAdapter.send(ws, msg, (err) => {
        if (!err) {
          return;
        }
        log(`[connection] send failed: ${err.message}`);
        if (onFailure) {
          onFailure(err);
        }
      });
      return true;
    } catch (err) {
      log(`[connection] send failed: ${err.message}`);
      if (onFailure) {
        onFailure(err);
      }
      return false;
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

  function transition(next) {
    const prev = state;
    state = next;
    log(`[connection] ${providerId ?? "?"}: ${prev} → ${next}`);
  }

  function rejectAllPending(reason) {
    for (const [callId, entry] of pendingCalls) {
      if (entry.timer) timerAdapter.cancel(entry.timer);
      entry.reject(new LifecycleError(reason ?? "provider disconnected", {
        code: TOOL_RESULT_ERROR.DISCONNECTED,
        context: { callId, providerId },
        retryable: false
      }));
    }
    pendingCalls.clear();
  }

  function clearPendingTimer(entry) {
    if (entry?.timer) {
      timerAdapter.cancel(entry.timer);
      entry.timer = null;
    }
  }

  function rejectPendingCall(callId, error) {
    const pending = pendingCalls.get(callId);
    if (!pending) {
      return false;
    }
    clearPendingTimer(pending);
    pendingCalls.delete(callId);
    pending.reject(error);
    return true;
  }

  function resolvePendingCall(callId, result) {
    const pending = pendingCalls.get(callId);
    if (!pending) {
      return false;
    }
    clearPendingTimer(pending);
    pendingCalls.delete(callId);
    pending.resolve(result);
    return true;
  }

  function findToolDefinition(toolName) {
    return tools.find((tool) => tool.name === toolName) ?? null;
  }

  function getToolTimeoutMs(toolName) {
    const tool = findToolDefinition(toolName);
    if (typeof tool?.timeout === "number" && tool.timeout > 0 && Number.isFinite(tool.timeout)) {
      return tool.timeout;
    }
    return null;
  }

  function createToolCallContext(callId, toolName, extra = {}) {
    return {
      providerId,
      providerName,
      sessionId,
      callId,
      toolName,
      ...extra
    };
  }

  function handleToolCallTimeout(callId, targetSessionId, toolName, timeoutMs) {
    const rejected = rejectPendingCall(callId, new TimeoutError(
      `Provider tool '${toolName}' timed out after ${timeoutMs}ms`,
      {
        code: TOOL_RESULT_ERROR.TIMEOUT,
        context: createToolCallContext(callId, toolName, { timeoutMs }),
        retryable: true
      }
    ));

    if (rejected) {
      sendToolCancelMsg(callId, targetSessionId, "timeout");
    }
  }

  function disconnectConnection(reason, { notifyUnbound, closeSocket } = {}) {
    if (state === CONNECTION_STATE.DISCONNECTED) return;

    transition(CONNECTION_STATE.DISCONNECTED);
    rejectAllPending(reason);

    if (notifyUnbound && onUnbound) {
      try { onUnbound(connection); } catch (err) { log(`[connection] onUnbound callback error: ${err.message}`); }
    }

    if (closeSocket) {
      try { websocketAdapter.close(ws); } catch { /* ignore */ }
    }
  }

  function executeAction(action, transitionResult) {
    switch (action.type) {
      case CONNECTION_ACTION.SEND:
        send(action.message);
        return;
      case CONNECTION_ACTION.SEND_ERROR:
        sendError(action.code, action.message, action.opts ?? {});
        return;
      case CONNECTION_ACTION.TRANSITION:
        transition(action.state);
        if (transitionResult?.nextState) {
          providerId = transitionResult.nextState.providerId ?? providerId;
          providerName = transitionResult.nextState.providerName ?? providerName;
          sessionId = transitionResult.nextState.sessionId ?? sessionId;
          tools = transitionResult.nextState.tools ?? tools;
          wasBound = transitionResult.nextState.wasBound ?? wasBound;
        }
        return;
      case CONNECTION_ACTION.REJECT_ALL_PENDING:
        rejectAllPending(action.reason);
        return;
      case CONNECTION_ACTION.NOTIFY_BOUND:
        if (onBound) {
          try { onBound(connection); } catch (err) { log(`[connection] onBound callback error: ${err.message}`); }
        }
        return;
      case CONNECTION_ACTION.NOTIFY_UNBOUND:
        if (onUnbound) {
          try { onUnbound(connection); } catch (err) { log(`[connection] onUnbound callback error: ${err.message}`); }
        }
        return;
      case CONNECTION_ACTION.CLOSE:
        try { websocketAdapter.close(ws); } catch { /* ignore */ }
        return;
      default:
        return;
    }
  }

  function applyTransition(event) {
    const transitionResult = computeTransition(
      {
        state,
        expectedToken,
        activeSessions,
        checkToolConflict,
        protocolVersion: PROTOCOL_VERSION,
        providerId,
        providerName,
        sessionId,
        tools,
        wasBound
      },
      event
    );

    for (const action of identifyActions(transitionResult)) {
      executeAction(action, transitionResult);
    }

    return transitionResult;
  }

  function handleAwaitAuth(msg) {
    applyTransition({ type: CONNECTION_EVENT.MESSAGE, message: msg });
  }

  function handleAwaitHello(msg) {
    applyTransition({ type: CONNECTION_EVENT.MESSAGE, message: msg, providerId: generateProviderId() });
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
          sessionId
        });
        return;
      }

      const result = v.result;
      const pending = pendingCalls.get(result.id);

      if (pending) {
        if (result.error) {
          const errorContext = { providerId, providerName, sessionId, callId: result.id };
          if (result.errorCode === TOOL_RESULT_ERROR.NOT_FOUND) {
            rejectPendingCall(result.id, new NotFoundError(result.error, { code: result.errorCode, context: errorContext }));
          } else if (result.errorCode === TOOL_RESULT_ERROR.TIMEOUT) {
            rejectPendingCall(result.id, new TimeoutError(result.error, { code: result.errorCode, context: errorContext, retryable: true }));
          } else if (result.errorCode === TOOL_RESULT_ERROR.DISCONNECTED || result.errorCode === TOOL_RESULT_ERROR.CANCELLED) {
            rejectPendingCall(result.id, new LifecycleError(result.error, { code: result.errorCode, context: errorContext }));
          } else {
            rejectPendingCall(result.id, new AppError(result.error, { code: result.errorCode ?? TOOL_RESULT_ERROR.INTERNAL, context: errorContext }));
          }
        } else {
          resolvePendingCall(result.id, result);
        }
      }

      if (onToolResult) {
        try { onToolResult(connection, result); } catch (err) { log(`[connection] onToolResult callback error: ${err.message}`); }
      }
      return;
    }

    if (msg.type === MESSAGE_TYPE.GOODBYE) {
      const v = validateGoodbye(msg);
      if (!v.ok) {
        log(`[connection] invalid goodbye: ${v.error}`);
      }
      disconnectConnection("provider sent goodbye", { notifyUnbound: true, closeSocket: true });
      return;
    }

    sendError(new ValidationError(`unknown message type: "${msg.type}"`, {
      code: ERROR_CODE.UNKNOWN_TYPE,
      context: { state, receivedType: msg.type }
    }));
  }

  function onMessage(raw) {
    if (state === CONNECTION_STATE.DISCONNECTED) return;

    const limit = state === CONNECTION_STATE.BOUND
      ? PAYLOAD_LIMIT.TOOL_RESULT
      : PAYLOAD_LIMIT.DEFAULT;

    const parsed = parseMessage(raw, limit);
    if (!parsed.ok) {
      const code = parsed.code === "PAYLOAD_TOO_LARGE"
        ? ERROR_CODE.PAYLOAD_TOO_LARGE
        : ERROR_CODE.INVALID_JSON;
      sendError(new ValidationError(parsed.error, { code, context: { state } }));
      return;
    }

    const msg = parsed.message;
    if (state !== CONNECTION_STATE.BOUND) {
      switch (state) {
        case CONNECTION_STATE.AWAIT_AUTH:
          handleAwaitAuth(msg);
          break;
        case CONNECTION_STATE.AWAIT_HELLO:
          handleAwaitHello(msg);
          break;
        default:
          break;
      }
      return;
    }

    if (msg.type === MESSAGE_TYPE.TOOL_RESULT || msg.type === MESSAGE_TYPE.GOODBYE) {
      handleBound(msg);
      return;
    }

    handleBound(msg);
  }

  function onClose() {
    disconnectConnection("WebSocket closed", { notifyUnbound: wasBound, closeSocket: false });
  }

  function onError(err) {
    log(`[connection] WebSocket error: ${err.message}`);
    disconnectConnection(`WebSocket error: ${err.message}`, { notifyUnbound: wasBound, closeSocket: false });
  }

  websocketAdapter.connect(ws, { message: onMessage, close: onClose, error: onError });

  function sendToolCallMsg(callId, targetSessionId, toolName, args) {
    if (state !== CONNECTION_STATE.BOUND) {
      return Promise.reject(new LifecycleError("connection not in Bound state", {
        code: TOOL_RESULT_ERROR.DISCONNECTED,
        context: { state },
        retryable: false
      }));
    }

    let message;
    try {
      message = buildToolCall(callId, targetSessionId, toolName, args);
    } catch (err) {
      return Promise.reject(err);
    }

    const timeoutMs = getToolTimeoutMs(toolName);

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      pendingCalls.set(callId, entry);

      if (timeoutMs !== null) {
        entry.timer = timerAdapter.schedule(() => {
          handleToolCallTimeout(callId, targetSessionId, toolName, timeoutMs);
        }, timeoutMs);
      }

      const sent = send(message, (err) => {
        rejectPendingCall(callId, new LifecycleError(`failed to send tool call: ${err.message}`, {
          code: TOOL_RESULT_ERROR.DISCONNECTED,
          context: createToolCallContext(callId, toolName),
          retryable: false,
          cause: err
        }));
      });

      if (!sent) {
        return;
      }
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
    disconnectConnection(reason ?? "connection closed by gateway", { notifyUnbound: wasBound, closeSocket: true });
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
    close
  };

  return connection;
}
