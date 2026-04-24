import { DELIVERY, MANAGED_BY, SCOPE } from "../consts.mjs";

export function normalizeName(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function normalizeScope(value, fallback = SCOPE.TEMPORARY) {
  return String(value ?? fallback).trim().toLowerCase() === SCOPE.PERSISTENT
    ? SCOPE.PERSISTENT
    : SCOPE.TEMPORARY;
}

export function normalizeManagedBy(value, fallback = MANAGED_BY.MODEL) {
  return String(value ?? fallback).trim().toLowerCase() === MANAGED_BY.USER
    ? MANAGED_BY.USER
    : MANAGED_BY.MODEL;
}

export function normalizeDelivery(value, fallback = DELIVERY.IMPORTANT) {
  return String(value ?? fallback).trim().toLowerCase() === DELIVERY.ALL
    ? DELIVERY.ALL
    : DELIVERY.IMPORTANT;
}
