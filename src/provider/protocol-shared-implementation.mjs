import { isNonArrayObject } from "../util/type-guards.mjs";

export function fail(error, extras) {
  return { ok: false, error, ...extras };
}

export function ok(extras) {
  return { ok: true, ...extras };
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPlainObject(value) {
  return isNonArrayObject(value);
}
