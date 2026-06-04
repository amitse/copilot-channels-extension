import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
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

function resolveInput(source) {
  const normalized = isPlainObject(source) ? source : {};

  return isPlainObject(normalized.eventFilter) ? normalized.eventFilter : normalized;
}

function compileRules(rules) {
  return rules.map((rule) => ({
    match: String(rule?.match ?? ""),
    regex: compileRegex(rule?.match, "rule.match"),
    outcome: rule?.outcome
  }));
}

function canonicalize(source, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  const normalized = resolveInput(source);
  const rawRules = Array.isArray(normalized.rules) ? normalized.rules : [];
  const ownership = normalizeOwnership(normalized.ownership ?? normalized.managedBy, fallbackOwnership);
  const lifespan = normalizeLifespan(normalized.lifespan ?? normalized.scope, fallbackLifespan);

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
export function create(spec = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  return canonicalize(spec, fallbackOwnership, fallbackLifespan);
}

/**
 * Extract the canonical filter input from a raw source.
 *
 * @param {Object} source
 * @returns {Object}
 */
export function getInput(source = {}) {
  return resolveInput(source);
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
  const source = isPlainObject(changes) ? changes : {};
  const changeInput = resolveInput(source);
  const ownership = changeInput.ownership
    ?? changeInput.managedBy
    ?? source.ownership
    ?? source.managedBy
    ?? current.ownership;
  const lifespan = changeInput.lifespan
    ?? changeInput.scope
    ?? source.lifespan
    ?? source.scope
    ?? current.lifespan;

  return canonicalize({
    ...serialize(current),
    ...changeInput,
    ownership,
    lifespan
  }, current.ownership, current.lifespan);
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
export function normalize(legacy, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  return canonicalize(legacy, fallbackOwnership, fallbackLifespan);
}

/**
 * Format a filter for user-facing display.
 *
 * @param {Object} filter
 * @returns {string}
 */
export function format(filter) {
  const source = resolveInput(filter);

  if (!Array.isArray(source.rules) || source.rules.length === 0) {
    return `rules=<none> lifespan=${source?.lifespan ?? "?"} ownership=${source?.ownership ?? "?"}`;
  }

  const resolved = canonicalize(source);
  const rulesSummary = resolved.rules
    .map((rule) => `${rule.outcome}:${JSON.stringify(rule.match)}`)
    .join(", ");

  return `rules=[${rulesSummary}] lifespan=${resolved.lifespan} ownership=${resolved.ownership}`;
}

export const EventFilterService = Object.freeze({
  getInput,
  create,
  update,
  evaluate,
  serialize,
  deserialize,
  normalize,
  format
});
