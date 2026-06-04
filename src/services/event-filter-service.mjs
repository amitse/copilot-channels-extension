import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeOwnership, normalizeLifespan } from "../util/normalize.mjs";
import { compileRegex } from "../util/regex.mjs";

/**
 * Canonical EventFilter schema.
 *
 * Runtime shape:
 * - rules: ordered list of { match, outcome, regex }
 * - ownership: OWNERSHIP.* value
 * - lifespan: LIFESPAN.* value
 *
 * Storage shape:
 * - rules: ordered list of { match, outcome }
 * - ownership: OWNERSHIP.* value
 * - lifespan: LIFESPAN.* value
 */

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function compileRules(rules) {
  return rules.map((rule) => ({
    match: String(rule?.match ?? ""),
    regex: compileRegex(rule?.match, "rule.match"),
    outcome: rule?.outcome
  }));
}

function canonicalize(source, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  const normalized = isPlainObject(source) ? source : {};
  const rawRules = Array.isArray(normalized.rules) ? normalized.rules : [];
  const ownership = normalizeOwnership(normalized.ownership, fallbackOwnership);
  const lifespan = normalizeLifespan(normalized.lifespan, fallbackLifespan);

  return Object.freeze({
    rules: Object.freeze(compileRules(rawRules).map((rule) => Object.freeze(rule))),
    ownership,
    lifespan
  });
}

/**
 * Create a canonical event filter from a raw spec.
 *
 * @param {Object} spec
 * @returns {Object}
 */
export function create(spec = {}) {
  return canonicalize(spec);
}

/**
 * Apply partial changes to an existing filter and return a new canonical filter.
 *
 * @param {Object} existing
 * @param {Object} changes
 * @returns {Object}
 */
export function update(existing, changes = {}) {
  const current = canonicalize(existing);

  return canonicalize({
    ...serialize(current),
    ...changes,
    ownership: changes.ownership ?? current.ownership,
    lifespan: changes.lifespan ?? current.lifespan
  });
}

/**
 * Evaluate a filter against one event line.
 *
 * @param {Object} filter
 * @param {string} event
 * @returns {string}
 */
export function evaluate(filter, event) {
  const text = String(event ?? "");
  const resolved = filter && Array.isArray(filter.rules) ? filter : canonicalize(filter);

  for (const rule of resolved.rules) {
    if (rule?.regex && rule.regex.test(text)) {
      return rule.outcome;
    }
  }

  return EVENT_OUTCOME.KEEP;
}

/**
 * Convert a canonical filter to its persisted storage shape.
 *
 * @param {Object} filter
 * @returns {{ rules: Array, ownership: string, lifespan: string }}
 */
export function serialize(filter) {
  const resolved = canonicalize(filter);

  return {
    rules: resolved.rules.map((rule) => ({
      match: rule.match,
      outcome: rule.outcome
    })),
    ownership: resolved.ownership,
    lifespan: resolved.lifespan
  };
}

/**
 * Hydrate a persisted filter into canonical runtime form.
 *
 * @param {Object} data
 * @returns {Object}
 */
export function deserialize(data) {
  return canonicalize(data);
}

/**
 * Normalize any legacy or partial filter representation.
 *
 * @param {Object} legacy
 * @returns {Object}
 */
export function normalize(legacy) {
  return canonicalize(legacy);
}

export const EventFilterService = Object.freeze({
  create,
  update,
  evaluate,
  serialize,
  deserialize,
  normalize
});
