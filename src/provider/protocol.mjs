import {
  PROTOCOL_VERSION,
  PAYLOAD_LIMIT,
  MAX_TOOLS_PER_PROVIDER,
  TOKEN_PREFIX,
  MESSAGE_TYPE,
  ERROR_CODE,
  TOOL_RESULT_ERROR,
  SESSION_LIFECYCLE_STATE,
} from "./consts.mjs";

const VALID_TOOL_ERROR_CODES = new Set(Object.values(TOOL_RESULT_ERROR));
const VALID_LIFECYCLE_STATES = new Set(Object.values(SESSION_LIFECYCLE_STATE));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error, extras) {
  return { ok: false, error, ...extras };
}

function ok(extras) {
  return { ok: true, ...extras };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw WebSocket data into a message object.
 * Enforces byte-size limits based on message type.
 * Returns `{ ok, message?, error? }`.
 */
export function parseMessage(raw, maxBytes) {
  if (raw == null) {
    return fail("raw message is null or undefined");
  }

  const text = typeof raw === "string" ? raw : String(raw);
  const byteLength = typeof Buffer !== "undefined"
    ? Buffer.byteLength(text, "utf8")
    : new TextEncoder().encode(text).byteLength;

  // Peek at the type to determine the applicable limit when no explicit
  // maxBytes is provided. tool.result gets a larger allowance.
  const effectiveLimit = maxBytes ?? PAYLOAD_LIMIT.DEFAULT;

  if (byteLength > effectiveLimit) {
    return fail(
      `payload too large: ${byteLength} bytes exceeds ${effectiveLimit} byte limit`,
      { code: "PAYLOAD_TOO_LARGE" },
    );
  }

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return fail("invalid JSON");
  }

  if (!isPlainObject(message)) {
    return fail("message must be a JSON object");
  }

  if (!isNonEmptyString(message.type)) {
    return fail("message missing required field: type");
  }

  return ok({ message });
}

// ---------------------------------------------------------------------------
// Validation — Provider → Gateway
// ---------------------------------------------------------------------------

/**
 * Validate an `auth` message from a provider.
 * Returns `{ ok, token }` or `{ ok: false, error }`.
 */
export function validateAuth(msg) {
  if (!isPlainObject(msg)) {
    return fail("auth message must be an object");
  }
  if (msg.type !== MESSAGE_TYPE.AUTH) {
    return fail(`expected type "${MESSAGE_TYPE.AUTH}", got "${msg.type}"`);
  }
  if (!isNonEmptyString(msg.token)) {
    return fail("auth message missing required field: token");
  }
  if (!msg.token.startsWith(TOKEN_PREFIX)) {
    return fail(`token must start with "${TOKEN_PREFIX}"`);
  }
  return ok({ token: msg.token });
}

/**
 * Validate a `hello` message from a provider.
 * Returns `{ ok, hello }` or `{ ok: false, error, code? }`.
 */
export function validateHello(msg) {
  if (!isPlainObject(msg)) {
    return fail("hello message must be an object");
  }
  if (msg.type !== MESSAGE_TYPE.HELLO) {
    return fail(`expected type "${MESSAGE_TYPE.HELLO}", got "${msg.type}"`);
  }
  if (!isNonEmptyString(msg.name)) {
    return fail("hello message missing required field: name");
  }
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return fail(
      `unsupported protocolVersion: ${msg.protocolVersion} (expected ${PROTOCOL_VERSION})`,
      { code: ERROR_CODE.UNSUPPORTED_VERSION },
    );
  }
  if (!isNonEmptyString(msg.session)) {
    return fail("hello message missing required field: session");
  }

  // Validate optional tools array
  if (msg.tools !== undefined) {
    if (!Array.isArray(msg.tools)) {
      return fail("hello.tools must be an array");
    }
    if (msg.tools.length > MAX_TOOLS_PER_PROVIDER) {
      return fail(
        `too many tools: ${msg.tools.length} exceeds limit of ${MAX_TOOLS_PER_PROVIDER}`,
      );
    }
    const seenNames = new Set();
    for (let i = 0; i < msg.tools.length; i++) {
      const toolResult = validateToolDef(msg.tools[i]);
      if (!toolResult.ok) {
        return fail(`tools[${i}]: ${toolResult.error}`);
      }
      if (seenNames.has(msg.tools[i].name)) {
        return fail(`tools[${i}]: duplicate tool name "${msg.tools[i].name}"`);
      }
      seenNames.add(msg.tools[i].name);
    }
  }

  return ok({
    hello: {
      name: msg.name,
      protocolVersion: msg.protocolVersion,
      session: msg.session,
      tools: msg.tools ?? [],
    },
  });
}

/**
 * Validate a single tool definition from a hello message.
 * Returns `{ ok }` or `{ ok: false, error }`.
 */
export function validateToolDef(tool) {
  if (!isPlainObject(tool)) {
    return fail("tool definition must be an object");
  }
  if (!isNonEmptyString(tool.name)) {
    return fail("tool definition missing required field: name");
  }
  if (!isNonEmptyString(tool.description)) {
    return fail("tool definition missing required field: description");
  }
  if (!isPlainObject(tool.parameters)) {
    return fail("tool definition missing required field: parameters (must be a JSON Schema object)");
  }

  // Optional timeout must be a positive number if present
  if (tool.timeout !== undefined) {
    if (typeof tool.timeout !== "number" || tool.timeout <= 0 || !Number.isFinite(tool.timeout)) {
      return fail("tool definition timeout must be a positive finite number (ms)");
    }
  }

  return ok();
}

/**
 * Validate a `tool.result` message from a provider.
 * Returns `{ ok, result }` or `{ ok: false, error }`.
 */
export function validateToolResult(msg) {
  if (!isPlainObject(msg)) {
    return fail("tool.result message must be an object");
  }
  if (msg.type !== MESSAGE_TYPE.TOOL_RESULT) {
    return fail(`expected type "${MESSAGE_TYPE.TOOL_RESULT}", got "${msg.type}"`);
  }
  if (!isNonEmptyString(msg.id)) {
    return fail("tool.result message missing required field: id");
  }

  const hasData = msg.data !== undefined;
  const hasError = msg.error !== undefined;

  if (hasData && hasError) {
    return fail("tool.result must contain exactly one of data or error, got both");
  }
  if (!hasData && !hasError) {
    return fail("tool.result must contain exactly one of data or error, got neither");
  }

  if (hasError) {
    if (!isNonEmptyString(msg.error)) {
      return fail("tool.result error must be a non-empty string");
    }
    if (msg.errorCode !== undefined && !VALID_TOOL_ERROR_CODES.has(msg.errorCode)) {
      return fail(
        `tool.result errorCode "${msg.errorCode}" is not valid (expected one of: ${[...VALID_TOOL_ERROR_CODES].join(", ")})`,
      );
    }
    return ok({
      result: {
        id: msg.id,
        error: msg.error,
        errorCode: msg.errorCode ?? TOOL_RESULT_ERROR.INTERNAL,
      },
    });
  }

  return ok({ result: { id: msg.id, data: msg.data } });
}

/**
 * Validate a `goodbye` message from a provider.
 * Returns `{ ok }` or `{ ok: false, error }`.
 */
export function validateGoodbye(msg) {
  if (!isPlainObject(msg)) {
    return fail("goodbye message must be an object");
  }
  if (msg.type !== MESSAGE_TYPE.GOODBYE) {
    return fail(`expected type "${MESSAGE_TYPE.GOODBYE}", got "${msg.type}"`);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Builders — Gateway → Provider
// ---------------------------------------------------------------------------

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
export function buildHelloAck(protocolVersion, providerId) {
  if (typeof protocolVersion !== "number") {
    throw new TypeError("protocolVersion must be a number");
  }
  if (!isNonEmptyString(providerId)) {
    throw new TypeError("providerId must be a non-empty string");
  }
  return {
    type: MESSAGE_TYPE.HELLO_ACK,
    protocolVersion,
    providerId,
  };
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
