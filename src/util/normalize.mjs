import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";

const USER_OWNED = OWNERSHIP.USER_OWNED.toLowerCase();
const MODEL_OWNED = OWNERSHIP.MODEL_OWNED.toLowerCase();
const DELIVERY_OUTCOMES = new Set([
  "important",
  "all",
  EVENT_OUTCOME.DROP,
  EVENT_OUTCOME.KEEP,
  EVENT_OUTCOME.SURFACE,
  EVENT_OUTCOME.INJECT
]);

export function normalizeName(value, fallback = "") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function describeInputType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function nameValidationContext(value, contextKey, context) {
  return {
    ...context,
    [contextKey]: value,
    type: describeInputType(value)
  };
}

export function requireNormalizedName(value, options = {}) {
  const {
    label = "Name",
    contextKey = "name",
    context = {}
  } = options;

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string.`, {
      context: nameValidationContext(value, contextKey, context)
    });
  }

  const normalized = normalizeName(value);
  if (!normalized) {
    throw new ValidationError(`${label} must resolve to a non-empty identifier.`, {
      context: nameValidationContext(value, contextKey, context)
    });
  }

  return normalized;
}

function normalizeLifespanFallback(value) {
  return String(value ?? "").trim().toLowerCase() === LIFESPAN.PERSISTENT
    ? LIFESPAN.PERSISTENT
    : LIFESPAN.TEMPORARY;
}

function normalizeOwnershipFallback(value) {
  return String(value ?? "").trim().toLowerCase() === USER_OWNED
    ? OWNERSHIP.USER_OWNED
    : OWNERSHIP.MODEL_OWNED;
}

export function normalizeLifespan(value, fallback = LIFESPAN.TEMPORARY) {
  const normalized = String(value ?? "").trim().toLowerCase();

  switch (normalized) {
    case LIFESPAN.PERSISTENT:
      return LIFESPAN.PERSISTENT;
    case LIFESPAN.TEMPORARY:
      return LIFESPAN.TEMPORARY;
    default:
      return normalizeLifespanFallback(fallback);
  }
}

export function normalizeOwnership(value, fallback = OWNERSHIP.MODEL_OWNED) {
  const normalized = String(value ?? "").trim().toLowerCase();

  switch (normalized) {
    case USER_OWNED:
      return OWNERSHIP.USER_OWNED;
    case MODEL_OWNED:
      return OWNERSHIP.MODEL_OWNED;
    default:
      return normalizeOwnershipFallback(fallback);
  }
}

export function normalizeOutcome(value, fallback = EVENT_OUTCOME.SURFACE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();

  switch (normalized) {
    case EVENT_OUTCOME.DROP:
    case EVENT_OUTCOME.KEEP:
    case EVENT_OUTCOME.SURFACE:
    case EVENT_OUTCOME.INJECT:
      return normalized;
    default:
      return String(fallback ?? EVENT_OUTCOME.SURFACE).trim().toLowerCase();
  }
}

export function normalizeDelivery(value, fallback = EVENT_OUTCOME.SURFACE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return DELIVERY_OUTCOMES.has(normalized)
    ? normalized
    : String(fallback ?? EVENT_OUTCOME.SURFACE).trim().toLowerCase();
}
