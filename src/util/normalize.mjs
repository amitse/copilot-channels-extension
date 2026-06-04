import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN } from "../consts.mjs";

const USER_OWNED = OWNERSHIP.USER_OWNED.toLowerCase();
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

export function normalizeLifespan(value, fallback = LIFESPAN.TEMPORARY) {
  return String(value ?? fallback).trim().toLowerCase() === LIFESPAN.PERSISTENT
    ? LIFESPAN.PERSISTENT
    : LIFESPAN.TEMPORARY;
}

export function normalizeOwnership(value, fallback = OWNERSHIP.MODEL_OWNED) {
  return String(value ?? fallback).trim().toLowerCase() === USER_OWNED
    ? OWNERSHIP.USER_OWNED
    : OWNERSHIP.MODEL_OWNED;
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
