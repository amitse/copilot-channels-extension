import {
  PROTOCOL_VERSION,
  MAX_TOOLS_PER_PROVIDER,
  TOKEN_PREFIX,
  MESSAGE_TYPE,
  ERROR_CODE,
  TOOL_RESULT_ERROR,
} from "./consts.mjs";
import { fail, isNonEmptyString, isPlainObject, ok } from "./protocol-shared.mjs";

const VALID_TOOL_ERROR_CODES = new Set(Object.values(TOOL_RESULT_ERROR));

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
