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

export function create(spec = {}) {
  return canonicalize(spec);
}

export function update(existing, changes = {}) {
  const current = canonicalize(existing);

  return canonicalize({
    ...serialize(current),
    ...changes,
    ownership: changes.ownership ?? current.ownership,
    lifespan: changes.lifespan ?? current.lifespan
  });
}

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

export function deserialize(data) {
  return canonicalize(data);
}

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
