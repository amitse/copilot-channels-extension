/**
 * Return true for values with the exact Object toString tag used by existing
 * config and emitter validation paths.
 *
 * This intentionally preserves the legacy `[object Object]` check rather than
 * trying to infer prototypes or reject class instances.
 */
export function isStrictPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Return true for any non-null object except arrays.
 *
 * Provider protocol validation historically accepts object-shaped values such
 * as Date, Map, RegExp, and class instances; keep that broader contract here.
 */
export function isNonArrayObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
