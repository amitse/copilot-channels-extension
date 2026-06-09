import {
  PROTOCOL_VERSION,
  MAX_TOOLS_PER_PROVIDER,
  TOKEN_PREFIX,
  MESSAGE_TYPE,
  ERROR_CODE,
  TOOL_RESULT_ERROR,
} from "./consts.mjs";
import { EVENT_OUTCOME } from "../consts.mjs";
import { fail, isNonBlankString, isNonEmptyString, isPlainObject, ok } from "./protocol-shared.mjs";
import { normalizeName } from "../util/normalize.mjs";

const VALID_TOOL_ERROR_CODES = new Set(Object.values(TOOL_RESULT_ERROR));
const VALID_PUSH_LEVELS = new Set([
  EVENT_OUTCOME.KEEP,
  EVENT_OUTCOME.SURFACE,
  EVENT_OUTCOME.INJECT
]);

function validateToolDefinitions(tools, fieldName = "tools") {
  if (!Array.isArray(tools)) {
    return fail(`${fieldName} must be an array`);
  }
  if (tools.length > MAX_TOOLS_PER_PROVIDER) {
    return fail(
      `too many tools: ${tools.length} exceeds limit of ${MAX_TOOLS_PER_PROVIDER}`,
    );
  }

  const seenNames = new Set();
  for (let i = 0; i < tools.length; i++) {
    const toolResult = validateToolDef(tools[i]);
    if (!toolResult.ok) {
      return fail(`${fieldName}[${i}]: ${toolResult.error}`);
    }
    if (seenNames.has(tools[i].name)) {
      return fail(`${fieldName}[${i}]: duplicate tool name "${tools[i].name}"`);
    }
    seenNames.add(tools[i].name);
  }

  return ok();
}

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
  if (!isNonBlankString(msg.name)) {
    return fail("hello message missing required field: name");
  }
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return fail(
      `unsupported protocolVersion: ${msg.protocolVersion} (expected ${PROTOCOL_VERSION})`,
      { code: ERROR_CODE.UNSUPPORTED_VERSION },
    );
  }
  if (!isNonBlankString(msg.session)) {
    return fail("hello message missing required field: session");
  }

  // Validate optional tools array
  if (msg.tools !== undefined) {
    const toolsResult = validateToolDefinitions(msg.tools, "hello.tools");
    if (!toolsResult.ok) {
      return fail(toolsResult.error);
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
 * Validate a bound-provider `push` message.
 * Returns `{ ok, push }` or `{ ok: false, error }`.
 */
export function validateProviderPush(msg) {
  if (!isPlainObject(msg)) {
    return fail("push message must be an object");
  }
  if (msg.type !== MESSAGE_TYPE.PUSH) {
    return fail(`expected type "${MESSAGE_TYPE.PUSH}", got "${msg.type}"`);
  }

  const level = String(msg.level ?? "").trim().toLowerCase();
  if (!VALID_PUSH_LEVELS.has(level)) {
    return fail(`push level must be one of: ${[...VALID_PUSH_LEVELS].join(", ")}`);
  }
  if (!isNonBlankString(msg.event)) {
    return fail("push message missing required field: event");
  }

  let stream;
  if (msg.stream !== undefined) {
    if (!isNonBlankString(msg.stream)) {
      return fail("push stream must be a non-empty string when provided");
    }
    stream = normalizeName(msg.stream);
    if (!stream) {
      return fail("push stream must resolve to a non-empty identifier");
    }
  }
  if (msg.sessionId !== undefined && !isNonBlankString(msg.sessionId)) {
    return fail("push sessionId must be a non-empty string when provided");
  }
  if (msg.metadata !== undefined && !isPlainObject(msg.metadata)) {
    return fail("push metadata must be an object when provided");
  }

  return ok({
    push: {
      level,
      event: msg.event,
      stream,
      sessionId: msg.sessionId === undefined ? undefined : msg.sessionId.trim(),
      metadata: msg.metadata
    }
  });
}

/**
 * Validate a bound-provider `tools.update` message.
 * Returns `{ ok, update }` or `{ ok: false, error }`.
 */
export function validateToolsUpdate(msg) {
  if (!isPlainObject(msg)) {
    return fail("tools.update message must be an object");
  }
  if (msg.type !== MESSAGE_TYPE.TOOLS_UPDATE) {
    return fail(`expected type "${MESSAGE_TYPE.TOOLS_UPDATE}", got "${msg.type}"`);
  }

  const toolsResult = validateToolDefinitions(msg.tools, "tools.update.tools");
  if (!toolsResult.ok) {
    return fail(toolsResult.error);
  }

  if (msg.sessionId !== undefined && !isNonBlankString(msg.sessionId)) {
    return fail("tools.update sessionId must be a non-empty string when provided");
  }

  return ok({
    update: {
      tools: msg.tools,
      sessionId: msg.sessionId === undefined ? undefined : msg.sessionId.trim()
    }
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
  if (!isNonBlankString(tool.name)) {
    return fail("tool definition missing required field: name");
  }
  if (!isNonBlankString(tool.description)) {
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
