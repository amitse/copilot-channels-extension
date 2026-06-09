import {
  MESSAGE_TYPE,
  SESSION_LIFECYCLE_STATE,
} from "./consts.mjs";
import { isNonEmptyString, isPlainObject } from "./protocol-shared.mjs";

const VALID_LIFECYCLE_STATES = new Set(Object.values(SESSION_LIFECYCLE_STATE));

/**
 * Build a `sessions` message listing active sessions.
 */
export function buildSessions(activeSessions) {
  if (!Array.isArray(activeSessions)) {
    throw new TypeError("activeSessions must be an array");
  }
  return {
    type: MESSAGE_TYPE.SESSIONS,
    active: activeSessions.map((s) => ({
      id: s.id,
      label: s.label,
      cwd: s.cwd,
    })),
  };
}

/**
 * Build a `hello.ack` message confirming protocol version and provider id.
 */
export function buildHelloAck(protocolVersion, providerId, sessionId) {
  if (typeof protocolVersion !== "number") {
    throw new TypeError("protocolVersion must be a number");
  }
  if (!isNonEmptyString(providerId)) {
    throw new TypeError("providerId must be a non-empty string");
  }
  const msg = {
    type: MESSAGE_TYPE.HELLO_ACK,
    protocolVersion,
    providerId
  };
  if (sessionId !== undefined) {
    if (!isNonEmptyString(sessionId)) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    msg.sessionId = sessionId;
  }
  return msg;
}

/**
 * Build a `tool.call` message dispatching a tool invocation to a provider.
 */
export function buildToolCall(id, sessionId, tool, args) {
  if (!isNonEmptyString(id)) {
    throw new TypeError("id must be a non-empty string");
  }
  if (!isNonEmptyString(sessionId)) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (!isNonEmptyString(tool)) {
    throw new TypeError("tool must be a non-empty string");
  }
  if (!isPlainObject(args)) {
    throw new TypeError("args must be a plain object");
  }
  return {
    type: MESSAGE_TYPE.TOOL_CALL,
    id,
    sessionId,
    tool,
    args,
  };
}

/**
 * Build a `tool.cancel` message requesting cancellation of a pending tool call.
 */
export function buildToolCancel(id, sessionId, reason) {
  if (!isNonEmptyString(id)) {
    throw new TypeError("id must be a non-empty string");
  }
  if (!isNonEmptyString(sessionId)) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  return {
    type: MESSAGE_TYPE.TOOL_CANCEL,
    id,
    sessionId,
    reason: reason ?? undefined,
  };
}

/**
 * Build a `session.lifecycle` message notifying the provider of session state.
 */
export function buildSessionLifecycle(sessionId, state, deadline) {
  if (!isNonEmptyString(sessionId)) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (!VALID_LIFECYCLE_STATES.has(state)) {
    throw new TypeError(
      `state must be one of: ${[...VALID_LIFECYCLE_STATES].join(", ")}`,
    );
  }
  const msg = {
    type: MESSAGE_TYPE.SESSION_LIFECYCLE,
    sessionId,
    state,
  };
  if (deadline !== undefined) {
    if (typeof deadline !== "number" || deadline <= 0 || !Number.isFinite(deadline)) {
      throw new TypeError("deadline must be a positive finite number (ms)");
    }
    msg.deadline = deadline;
  }
  return msg;
}

/**
 * Build an `error` message sent from the gateway to a provider.
 * `opts` may include `replyTo`, `providerId`, and `sessionId`.
 */
export function buildError(code, message, opts = {}) {
  if (!isNonEmptyString(code)) {
    throw new TypeError("code must be a non-empty string");
  }
  if (!isNonEmptyString(message)) {
    throw new TypeError("message must be a non-empty string");
  }
  const msg = { type: MESSAGE_TYPE.ERROR, code, message };
  if (opts.replyTo !== undefined) msg.replyTo = opts.replyTo;
  if (opts.providerId !== undefined) msg.providerId = opts.providerId;
  if (opts.sessionId !== undefined) msg.sessionId = opts.sessionId;
  return msg;
}
