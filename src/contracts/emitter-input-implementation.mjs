import { ValidationError } from "../errors/index.mjs";
import { normalizeName, requireNormalizedName } from "../util/normalize.mjs";

export function readOptionalText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function resolveEmitterStreamInput(source = {}, fallbackName = null) {
  return readOptionalText(source?.stream) ?? readOptionalText(source?.channel) ?? fallbackName;
}

export function normalizeEmitterStreamInput(source = {}, fallbackName = "") {
  const explicitStream = readOptionalText(source?.stream);
  if (explicitStream !== null) {
    return requireNormalizedName(explicitStream, {
      label: "Emitter stream",
      contextKey: "stream"
    });
  }

  const explicitChannel = readOptionalText(source?.channel);
  if (explicitChannel !== null) {
    return requireNormalizedName(explicitChannel, {
      label: "Emitter channel",
      contextKey: "channel"
    });
  }

  return normalizeName(fallbackName);
}

export function normalizeEmitterStreamInputTolerant(source = {}, fallbackName = "") {
  const normalizedFallback = normalizeName(fallbackName);
  return normalizeName(source?.stream, normalizeName(source?.channel, normalizedFallback));
}

export function normalizeOptionalPositiveInteger(value, options = {}) {
  const {
    label = "value",
    errorPrefix = ""
  } = options;
  const prefix = errorPrefix ? `${errorPrefix}: ` : "";

  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }

  let integer = null;
  if (typeof value === "number") {
    integer = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      integer = Number(text);
    }
  }

  if (!Number.isSafeInteger(integer)) {
    throw new ValidationError(`${prefix}${label} must be a positive integer.`);
  }
  if (integer < 1) {
    throw new ValidationError(`${prefix}${label} must be 1 or greater.`);
  }

  return integer;
}
