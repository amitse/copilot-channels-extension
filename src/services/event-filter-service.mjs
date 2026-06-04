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
 *
 * Legacy inputs accepted by normalize()/create()/deserialize():
 * - { includePattern, excludePattern, notifyPattern }
 * - { eventFilter: {...} } or { classifier: {...} }
 * - full emitter-like objects with filter fields on the top level
 *
 * Validation rules:
 * - regex compilation is case-insensitive and must succeed for each rule.match
 * - ownership/lifespan are normalized through existing canonicalizers
 * - legacy include/exclude/notify fields are translated into ordered rules
 *   in the same precedence used by the previous implementation:
 *   exclude → notify → include → catch-all drop
 */

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function unwrapSource(input) {
  if (!isPlainObject(input)) {
    return {};
  }

  if (isPlainObject(input.eventFilter)) {
    return {
      ...input.eventFilter,
      ownership: input.eventFilter.ownership ?? input.eventFilter.managedBy ?? input.ownership ?? input.managedBy,
      lifespan: input.eventFilter.lifespan ?? input.eventFilter.scope ?? input.lifespan ?? input.scope
    };
  }

  if (isPlainObject(input.classifier)) {
    return {
      ...input.classifier,
      ownership: input.classifier.ownership ?? input.classifier.managedBy ?? input.ownership ?? input.managedBy,
      lifespan: input.classifier.lifespan ?? input.classifier.scope ?? input.lifespan ?? input.scope
    };
  }

  return { ...input };
}

function legacyToRules(source) {
  const rules = [];
  if (source.excludePattern) {
    rules.push({ match: String(source.excludePattern), outcome: EVENT_OUTCOME.DROP });
  }
  if (source.notifyPattern) {
    rules.push({ match: String(source.notifyPattern), outcome: EVENT_OUTCOME.INJECT });
  }
  if (source.includePattern) {
    rules.push({ match: String(source.includePattern), outcome: EVENT_OUTCOME.KEEP });
    rules.push({ match: ".*", outcome: EVENT_OUTCOME.DROP });
  }
  return rules;
}

function compileRules(rules) {
  return rules.map((rule) => ({
    match: String(rule?.match ?? ""),
    regex: compileRegex(rule?.match, "rule.match"),
    outcome: rule?.outcome
  }));
}

function canonicalize(source, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  const normalized = unwrapSource(source);
  const rawRules = Array.isArray(normalized.rules) ? normalized.rules : legacyToRules(normalized);
  const ownership = normalizeOwnership(normalized.ownership ?? normalized.managedBy, fallbackOwnership);
  const lifespan = normalizeLifespan(normalized.lifespan ?? normalized.scope, fallbackLifespan);

  return Object.freeze({
    rules: Object.freeze(compileRules(rawRules).map((rule) => Object.freeze(rule))),
    ownership,
    lifespan
  });
}

function hasLegacyPatternChanges(changes = {}) {
  return Boolean(changes && (changes.includePattern !== undefined || changes.excludePattern !== undefined || changes.notifyPattern !== undefined));
}

export function create(spec = {}) {
  return canonicalize(spec);
}

export function update(existing, changes = {}) {
  const current = canonicalize(existing);

  if (hasLegacyPatternChanges(changes)) {
    return canonicalize({
      ...changes,
      ownership: changes.ownership ?? changes.managedBy ?? current.ownership,
      lifespan: changes.lifespan ?? changes.scope ?? current.lifespan
    });
  }

  return canonicalize({
    ...serialize(current),
    ...changes,
    ownership: changes.ownership ?? changes.managedBy ?? current.ownership,
    lifespan: changes.lifespan ?? changes.scope ?? current.lifespan
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
