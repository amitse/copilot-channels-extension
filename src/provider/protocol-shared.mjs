export function fail(error, extras) {
  return { ok: false, error, ...extras };
}

export function ok(extras) {
  return { ok: true, ...extras };
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
