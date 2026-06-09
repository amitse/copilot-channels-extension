import { MESSAGE_TYPE, PAYLOAD_LIMIT } from "./consts.mjs";
import { fail, isNonEmptyString, isPlainObject, ok } from "./protocol-shared.mjs";

function payloadTooLarge(byteLength, limit) {
  return fail(
    `payload too large: ${byteLength} bytes exceeds ${limit} byte limit`,
    { code: "PAYLOAD_TOO_LARGE" },
  );
}

function hasBuffer() {
  return typeof Buffer !== "undefined" && typeof Buffer.from === "function";
}

function isArrayBufferLike(value) {
  return (
    typeof ArrayBuffer !== "undefined" &&
    value instanceof ArrayBuffer
  ) || (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  );
}

function isArrayBufferView(value) {
  return (
    typeof ArrayBuffer !== "undefined" &&
    typeof ArrayBuffer.isView === "function" &&
    ArrayBuffer.isView(value)
  );
}

function toBufferPayload(raw) {
  if (typeof raw === "string") {
    return Buffer.from(raw, "utf8");
  }
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((fragment) => toBufferPayload(fragment)));
  }
  if (isArrayBufferLike(raw)) {
    return Buffer.from(raw);
  }
  if (isArrayBufferView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return Buffer.from(String(raw), "utf8");
}

function encodeText(text) {
  return new TextEncoder().encode(text);
}

function toUint8ArrayPayload(raw) {
  if (typeof raw === "string") {
    return encodeText(raw);
  }
  if (Array.isArray(raw)) {
    const fragments = raw.map((fragment) => toUint8ArrayPayload(fragment));
    const byteLength = fragments.reduce((total, fragment) => total + fragment.byteLength, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const fragment of fragments) {
      bytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    return bytes;
  }
  if (isArrayBufferLike(raw)) {
    return new Uint8Array(raw);
  }
  if (isArrayBufferView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return encodeText(String(raw));
}

function decodeRawPayload(raw) {
  if (hasBuffer()) {
    const bytes = toBufferPayload(raw);
    return {
      text: bytes.toString("utf8"),
      byteLength: bytes.byteLength
    };
  }

  const bytes = toUint8ArrayPayload(raw);
  return {
    text: new TextDecoder().decode(bytes),
    byteLength: bytes.byteLength
  };
}

/**
 * Parse raw WebSocket data into a message object.
 * When `maxBytes` is omitted, enforces the protocol's message-type limits:
 * `tool.result` may use the larger tool-result allowance; all other message
 * types, malformed JSON, and messages whose type cannot be identified remain
 * capped at the default allowance.
 * Returns `{ ok, message?, error? }`.
 */
export function parseMessage(raw, maxBytes) {
  if (raw == null) {
    return fail("raw message is null or undefined");
  }

  let decoded;
  try {
    decoded = decodeRawPayload(raw);
  } catch {
    return fail("raw message could not be decoded");
  }
  const { text, byteLength } = decoded;

  const hasExplicitLimit = maxBytes !== undefined;
  if (hasExplicitLimit && byteLength > maxBytes) {
    return payloadTooLarge(byteLength, maxBytes);
  }

  if (!hasExplicitLimit && byteLength > PAYLOAD_LIMIT.TOOL_RESULT) {
    return payloadTooLarge(byteLength, PAYLOAD_LIMIT.TOOL_RESULT);
  }

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    if (!hasExplicitLimit && byteLength > PAYLOAD_LIMIT.DEFAULT) {
      return payloadTooLarge(byteLength, PAYLOAD_LIMIT.DEFAULT);
    }
    return fail("invalid JSON");
  }

  if (!isPlainObject(message)) {
    if (!hasExplicitLimit && byteLength > PAYLOAD_LIMIT.DEFAULT) {
      return payloadTooLarge(byteLength, PAYLOAD_LIMIT.DEFAULT);
    }
    return fail("message must be a JSON object");
  }

  if (!isNonEmptyString(message.type)) {
    if (!hasExplicitLimit && byteLength > PAYLOAD_LIMIT.DEFAULT) {
      return payloadTooLarge(byteLength, PAYLOAD_LIMIT.DEFAULT);
    }
    return fail("message missing required field: type");
  }

  if (!hasExplicitLimit) {
    const effectiveLimit = message.type === MESSAGE_TYPE.TOOL_RESULT
      ? PAYLOAD_LIMIT.TOOL_RESULT
      : PAYLOAD_LIMIT.DEFAULT;
    if (byteLength > effectiveLimit) {
      return payloadTooLarge(byteLength, effectiveLimit);
    }
  }

  return ok({ message });
}
