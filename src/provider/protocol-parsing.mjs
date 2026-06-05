import { PAYLOAD_LIMIT } from "./consts.mjs";
import { fail, isNonEmptyString, isPlainObject, ok } from "./protocol-shared.mjs";

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
