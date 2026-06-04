import { CONNECTION_STATE, ERROR_CODE, MESSAGE_TYPE, TOOL_RESULT_ERROR, FATAL_ERROR_CODES } from "./consts.mjs";
import {
  buildHelloAck,
  buildSessions,
  validateAuth,
  validateHello,
  validateGoodbye,
  validateToolResult
} from "./protocol.mjs";

export const CONNECTION_EVENT = Object.freeze({
  MESSAGE: "message",
  CLOSE: "close",
  ERROR: "error",
  SEND_TOOL_CALL: "sendToolCall",
  SEND_TOOL_CANCEL: "sendToolCancel",
  SEND_LIFECYCLE: "sendLifecycle"
});

export const CONNECTION_ACTION = Object.freeze({
  SEND: "send",
  SEND_ERROR: "sendError",
  TRANSITION: "transition",
  REJECT_ALL_PENDING: "rejectAllPending",
  NOTIFY_BOUND: "notifyBound",
  NOTIFY_UNBOUND: "notifyUnbound",
  CLOSE: "close"
});

function disconnectActions(reason, wasBound) {
  return [
    { type: CONNECTION_ACTION.TRANSITION, state: CONNECTION_STATE.DISCONNECTED },
    { type: CONNECTION_ACTION.REJECT_ALL_PENDING, reason },
    ...(wasBound ? [{ type: CONNECTION_ACTION.NOTIFY_UNBOUND }] : []),
    { type: CONNECTION_ACTION.CLOSE }
  ];
}

export function computeTransition(currentState, event) {
  const state = { ...currentState };
  const type = event?.type;
  const message = event?.message;

  if (type === CONNECTION_EVENT.CLOSE) {
    if (state.state === CONNECTION_STATE.DISCONNECTED) {
      return { currentState, nextState: state, actions: [] };
    }
    return {
      currentState,
      nextState: { ...state, state: CONNECTION_STATE.DISCONNECTED },
      actions: disconnectActions("WebSocket closed", state.wasBound)
    };
  }

  if (type === CONNECTION_EVENT.ERROR) {
    if (state.state === CONNECTION_STATE.DISCONNECTED) {
      return { currentState, nextState: state, actions: [] };
    }
    return {
      currentState,
      nextState: { ...state, state: CONNECTION_STATE.DISCONNECTED },
      actions: disconnectActions(`WebSocket error: ${event?.error?.message ?? "unknown error"}`, state.wasBound)
    };
  }

  if (type === CONNECTION_EVENT.MESSAGE) {
    if (state.state === CONNECTION_STATE.AWAIT_AUTH) {
      if (message.type !== MESSAGE_TYPE.AUTH) {
        return {
          currentState,
          nextState: state,
          actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.UNKNOWN_TYPE, message: `expected auth, got "${message.type}"` }]
        };
      }
      const v = validateAuth(message);
      if (!v.ok) {
        return {
          currentState,
          nextState: { ...state, state: CONNECTION_STATE.DISCONNECTED },
          actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.AUTH_FAILED, message: v.error }].concat(disconnectActions(v.error, false))
        };
      }
      if (v.token !== state.expectedToken) {
        return {
          currentState,
          nextState: { ...state, state: CONNECTION_STATE.DISCONNECTED },
          actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.AUTH_FAILED, message: "invalid token" }].concat(disconnectActions("invalid token", false))
        };
      }
      return {
        currentState,
        nextState: { ...state, state: CONNECTION_STATE.AWAIT_HELLO },
        actions: [
          { type: CONNECTION_ACTION.SEND, message: buildSessions(state.activeSessions ?? []) },
          { type: CONNECTION_ACTION.TRANSITION, state: CONNECTION_STATE.AWAIT_HELLO }
        ]
      };
    }

    if (state.state === CONNECTION_STATE.AWAIT_HELLO) {
      if (message.type !== MESSAGE_TYPE.HELLO) {
        return {
          currentState,
          nextState: state,
          actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.UNKNOWN_TYPE, message: `expected hello, got "${message.type}"` }]
        };
      }
      const v = validateHello(message);
      if (!v.ok) {
        const code = v.code ?? ERROR_CODE.UNKNOWN_TYPE;
        const fatal = FATAL_ERROR_CODES.includes(code);
        return {
          currentState,
          nextState: fatal ? { ...state, state: CONNECTION_STATE.DISCONNECTED } : state,
          actions: fatal
            ? [{ type: CONNECTION_ACTION.SEND_ERROR, code, message: v.error }].concat(disconnectActions(v.error, false))
            : [{ type: CONNECTION_ACTION.SEND_ERROR, code, message: v.error }]
        };
      }
      const hello = v.hello;
      const sessionMatch = (state.activeSessions ?? []).find((s) => s.id === hello.session);
      if (!sessionMatch) {
        return {
          currentState,
          nextState: state,
          actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.INVALID_SESSION, message: `unknown session: ${hello.session}` }]
        };
      }
      if (state.checkToolConflict && hello.tools.length > 0) {
        const conflicts = state.checkToolConflict(hello.tools);
        if (conflicts?.length > 0) {
          return {
            currentState,
            nextState: state,
            actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.TOOL_CONFLICT, message: `tool name conflict: ${conflicts.join(", ")}` }]
          };
        }
      }

      return {
        currentState,
        nextState: {
          ...state,
          state: CONNECTION_STATE.BOUND,
          providerId: event?.providerId ?? state.providerId,
          providerName: hello.name,
          sessionId: hello.session,
          tools: hello.tools,
          wasBound: true
        },
        actions: [
          { type: CONNECTION_ACTION.SEND, message: buildHelloAck(state.protocolVersion, event?.providerId ?? state.providerId) },
          { type: CONNECTION_ACTION.TRANSITION, state: CONNECTION_STATE.BOUND },
          { type: CONNECTION_ACTION.NOTIFY_BOUND }
        ]
      };
    }

    if (state.state === CONNECTION_STATE.BOUND) {
      if (message.type === MESSAGE_TYPE.TOOL_RESULT) {
        const v = validateToolResult(message);
        return {
          currentState,
          nextState: state,
          actions: v.ok
            ? [{ type: CONNECTION_ACTION.SEND, message: { type: MESSAGE_TYPE.TOOL_RESULT, result: v.result } }]
            : [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.UNKNOWN_TYPE, message: v.error }]
        };
      }
      if (message.type === MESSAGE_TYPE.GOODBYE) {
        const v = validateGoodbye(message);
        return {
          currentState,
          nextState: { ...state, state: CONNECTION_STATE.DISCONNECTED },
          actions: disconnectActions(v.ok ? "provider sent goodbye" : v.error, state.wasBound)
        };
      }
      return {
        currentState,
        nextState: state,
        actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: ERROR_CODE.UNKNOWN_TYPE, message: `unknown message type: "${message.type}"` }]
      };
    }
  }

  if (type === CONNECTION_EVENT.SEND_TOOL_CALL) {
    if (state.state !== CONNECTION_STATE.BOUND) {
      return {
        currentState,
        nextState: state,
        actions: [{ type: CONNECTION_ACTION.SEND_ERROR, code: TOOL_RESULT_ERROR.DISCONNECTED, message: "connection not in Bound state" }]
      };
    }
    return {
      currentState,
      nextState: state,
      actions: [{ type: CONNECTION_ACTION.SEND, message: event.message }]
    };
  }

  if (type === CONNECTION_EVENT.SEND_TOOL_CANCEL || type === CONNECTION_EVENT.SEND_LIFECYCLE) {
    if (state.state !== CONNECTION_STATE.BOUND) {
      return { currentState, nextState: state, actions: [] };
    }
    return { currentState, nextState: state, actions: [{ type: CONNECTION_ACTION.SEND, message: event.message }] };
  }

  return { currentState, nextState: state, actions: [] };
}

export function identifyActions(transition) {
  return Array.isArray(transition?.actions) ? transition.actions : [];
}
