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
  validateProviderPush,
  validateToolResult,
  validateToolsUpdate,
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
import { createDefaultTimerAdapter } from "../util/timer-adapter.mjs";

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

export function createProviderConnection(ws, options, adapters = {}) {
  const {
    expectedToken,
    activeSessions,
    onBound,
    onUnbound,
    onPush,
    onToolsUpdate,
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
  let adapterCleanup = null;
  let adapterCleanupRequested = false;
  let adapterCleanupInvoked = false;

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

  function rejectSolePendingCall(error) {
    if (pendingCalls.size !== 1) {
      return false;
    }

    const [callId] = pendingCalls.keys();
    return rejectPendingCall(callId, error);
  }

  function failUncorrelatablePendingCalls(error, reason) {
    if (pendingCalls.size === 0) {
      return;
    }

    if (rejectSolePendingCall(error)) {
      return;
    }

    disconnectConnection(reason ?? error.message, { notifyUnbound: true, closeSocket: true });
  }

  function createUnknownToolResultError(callId) {
    return new ValidationError(`tool.result id '${callId}' does not match any pending provider tool call`, {
      code: ERROR_CODE.UNKNOWN_CALL_ID,
      context: { providerId, sessionId, replyTo: callId, callId, pendingCalls: pendingCalls.size }
    });
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

  function getToolTimeoutMs(tool) {
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

  function createBoundMessageContext(messageType, extra = {}) {
    return {
      providerId,
      providerName,
      sessionId,
      receivedType: messageType,
      ...extra
    };
  }

  function sendBoundValidationError(messageType, message, code = ERROR_CODE.UNKNOWN_TYPE, extra = {}) {
    const error = new ValidationError(message, {
      code,
      context: createBoundMessageContext(messageType, extra)
    });
    sendError(error, undefined, {
      replyTo: messageType,
      providerId,
      sessionId
    });
  }

  function hasInvalidTargetSession(targetSessionId) {
    return targetSessionId !== undefined && targetSessionId !== sessionId;
  }

  function errorMessage(err) {
    try {
      return err instanceof Error ? err.message : String(err);
    } catch {
      return "<unprintable error>";
    }
  }

  function safeLog(message) {
    try {
      log(message);
    } catch {
      // Callback error handling is best-effort and must not create another rejection.
    }
  }

  function runAdapterCleanup() {
    adapterCleanupRequested = true;
    if (adapterCleanupInvoked || typeof adapterCleanup !== "function") {
      return;
    }

    const cleanup = adapterCleanup;
    adapterCleanup = null;
    adapterCleanupInvoked = true;
    try {
      cleanup();
    } catch (err) {
      safeLog(`[connection] websocket cleanup failed: ${errorMessage(err)}`);
    }
  }

  function storeAdapterCleanup(cleanup) {
    adapterCleanup = typeof cleanup === "function" ? cleanup : null;
    if (adapterCleanupRequested) {
      runAdapterCleanup();
    }
  }

  function handleCallbackError(callbackName, err, onError) {
    try {
      onError(err);
    } catch (handlerErr) {
      safeLog(`[connection] ${callbackName} callback error handler failed: ${errorMessage(handlerErr)}`);
    }
  }

  function logCallbackError(callbackName, err) {
    safeLog(`[connection] ${callbackName} callback error: ${errorMessage(err)}`);
  }

  function isThenable(value) {
    return value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function";
  }

  function invokeProviderCallback(callbackName, callback, args, onError, onAccepted) {
    const accept = () => {
      if (typeof onAccepted === "function") {
        onAccepted();
      }
    };

    if (typeof callback !== "function") {
      accept();
      return true;
    }

    try {
      const result = callback(...args);
      if (isThenable(result)) {
        Promise.resolve(result).then(
          () => {
            accept();
          },
          (err) => {
            handleCallbackError(callbackName, err, onError);
          }
        );
      } else {
        accept();
      }
      return true;
    } catch (err) {
      handleCallbackError(callbackName, err, onError);
      return false;
    }
  }

  function handleProviderPush(msg) {
    const v = validateProviderPush(msg);
    if (!v.ok) {
      sendBoundValidationError(MESSAGE_TYPE.PUSH, v.error);
      return;
    }

    if (hasInvalidTargetSession(v.push.sessionId)) {
      sendBoundValidationError(
        MESSAGE_TYPE.PUSH,
        `push sessionId '${v.push.sessionId}' does not match bound session '${sessionId}'`,
        ERROR_CODE.INVALID_SESSION,
        { targetSessionId: v.push.sessionId }
      );
      return;
    }

    invokeProviderCallback("onPush", onPush, [connection, v.push], (err) => {
      sendError(err, undefined, {
        replyTo: MESSAGE_TYPE.PUSH,
        providerId,
        sessionId
      });
    });
  }

  function handleToolsUpdate(msg) {
    const v = validateToolsUpdate(msg);
    if (!v.ok) {
      sendBoundValidationError(MESSAGE_TYPE.TOOLS_UPDATE, v.error);
      return;
    }

    if (hasInvalidTargetSession(v.update.sessionId)) {
      sendBoundValidationError(
        MESSAGE_TYPE.TOOLS_UPDATE,
        `tools.update sessionId '${v.update.sessionId}' does not match bound session '${sessionId}'`,
        ERROR_CODE.INVALID_SESSION,
        { targetSessionId: v.update.sessionId }
      );
      return;
    }

    invokeProviderCallback("onToolsUpdate", onToolsUpdate, [connection, v.update], (err) => {
      sendError(err, undefined, {
        replyTo: MESSAGE_TYPE.TOOLS_UPDATE,
        providerId,
        sessionId
      });
    }, () => {
      tools = v.update.tools;
    });
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
    runAdapterCleanup();
    if (state === CONNECTION_STATE.DISCONNECTED) return;

    transition(CONNECTION_STATE.DISCONNECTED);
    rejectAllPending(reason);

    if (notifyUnbound) {
      invokeProviderCallback("onUnbound", onUnbound, [connection], (err) => {
        logCallbackError("onUnbound", err);
      });
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
        if (action.state === CONNECTION_STATE.DISCONNECTED) {
          runAdapterCleanup();
        }
        return;
      case CONNECTION_ACTION.REJECT_ALL_PENDING:
        rejectAllPending(action.reason);
        return;
      case CONNECTION_ACTION.NOTIFY_BOUND:
        invokeProviderCallback("onBound", onBound, [connection], (err) => {
          logCallbackError("onBound", err);
        });
        return;
      case CONNECTION_ACTION.NOTIFY_UNBOUND:
        invokeProviderCallback("onUnbound", onUnbound, [connection], (err) => {
          logCallbackError("onUnbound", err);
        });
        return;
      case CONNECTION_ACTION.CLOSE:
        runAdapterCleanup();
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
        const callId = typeof msg.id === "string" ? msg.id : undefined;
        const validationError = new ValidationError(v.error, {
          code: ERROR_CODE.UNKNOWN_TYPE,
          context: { providerId, sessionId, replyTo: callId, callId, pendingCalls: pendingCalls.size }
        });

        sendError(validationError, undefined, {
          replyTo: callId,
          providerId,
          sessionId
        });
        if (callId && pendingCalls.has(callId)) {
          rejectPendingCall(callId, validationError);
        } else {
          failUncorrelatablePendingCalls(validationError, `provider sent uncorrelatable tool.result: ${v.error}`);
        }
        return;
      }

      const result = v.result;
      const pending = pendingCalls.get(result.id);

      if (!pending) {
        const validationError = createUnknownToolResultError(result.id);
        sendError(validationError, undefined, {
          replyTo: result.id,
          providerId,
          sessionId
        });
        failUncorrelatablePendingCalls(
          validationError,
          `provider sent uncorrelatable tool.result with unknown tool.result id '${result.id}'`
        );
        return;
      }

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

      invokeProviderCallback("onToolResult", onToolResult, [connection, result], (err) => {
        logCallbackError("onToolResult", err);
      });
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

    if (msg.type === MESSAGE_TYPE.PUSH) {
      handleProviderPush(msg);
      return;
    }

    if (msg.type === MESSAGE_TYPE.TOOLS_UPDATE) {
      handleToolsUpdate(msg);
      return;
    }

    sendError(new ValidationError(`unknown message type: "${msg.type}"`, {
      code: ERROR_CODE.UNKNOWN_TYPE,
      context: { state, receivedType: msg.type }
    }));
  }

  function onMessage(raw) {
    if (state === CONNECTION_STATE.DISCONNECTED) return;

    const parsed = state === CONNECTION_STATE.BOUND
      ? parseMessage(raw)
      : parseMessage(raw, PAYLOAD_LIMIT.DEFAULT);
    if (!parsed.ok) {
      const code = parsed.code === "PAYLOAD_TOO_LARGE"
        ? ERROR_CODE.PAYLOAD_TOO_LARGE
        : ERROR_CODE.INVALID_JSON;
      const validationError = new ValidationError(parsed.error, {
        code,
        context: { state, providerId, sessionId, pendingCalls: pendingCalls.size }
      });
      sendError(validationError);
      if (state === CONNECTION_STATE.BOUND) {
        failUncorrelatablePendingCalls(validationError, `provider sent uncorrelatable message: ${parsed.error}`);
      }
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

  storeAdapterCleanup(websocketAdapter.connect(ws, { message: onMessage, close: onClose, error: onError }));

  function sendToolCallMsg(callId, targetSessionId, toolName, args) {
    if (state !== CONNECTION_STATE.BOUND) {
      return Promise.reject(new LifecycleError("connection not in Bound state", {
        code: TOOL_RESULT_ERROR.DISCONNECTED,
        context: { state },
        retryable: false
      }));
    }

    if (pendingCalls.has(callId)) {
      return Promise.reject(new ConflictError(`Provider tool call id already pending: ${callId}`, {
        context: createToolCallContext(callId, toolName, { targetSessionId }),
        retryable: false
      }));
    }

    const tool = findToolDefinition(toolName);
    if (!tool) {
      return Promise.reject(new NotFoundError(`Provider tool '${toolName}' is not available`, {
        code: TOOL_RESULT_ERROR.NOT_FOUND,
        context: createToolCallContext(callId, toolName, { targetSessionId }),
        retryable: false
      }));
    }

    let message;
    try {
      message = buildToolCall(callId, targetSessionId, toolName, args);
    } catch (err) {
      return Promise.reject(err);
    }

    const timeoutMs = getToolTimeoutMs(tool);

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, toolName, targetSessionId };
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
    get pendingCallCount() { return pendingCalls.size; },
    sendToolCall: sendToolCallMsg,
    sendToolCancel: sendToolCancelMsg,
    sendLifecycle,
    close
  };

  return connection;
}
