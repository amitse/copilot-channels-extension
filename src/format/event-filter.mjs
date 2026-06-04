import { OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { normalizeOwnership, normalizeLifespan } from "../util/normalize.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";

export function createEventFilter(source = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  return EventFilterService.create({
    ...source,
    ownership: normalizeOwnership(source.ownership, fallbackOwnership),
    lifespan: normalizeLifespan(source.lifespan, fallbackLifespan)
  });
}

export function evaluateEventFilter(filter, text) {
  return EventFilterService.evaluate(filter, text);
}

export function getEventFilterInput(source = {}) {
  if (source.eventFilter && typeof source.eventFilter === "object") {
    return source.eventFilter;
  }

  return source;
}

export function formatEventFilter(filter) {
  if (!filter || !filter.rules || filter.rules.length === 0) {
    return `rules=<none> lifespan=${filter?.lifespan ?? "?"} ownership=${filter?.ownership ?? "?"}`;
  }
  const rulesSummary = filter.rules
    .map(r => `${r.outcome}:${JSON.stringify(r.match)}`)
    .join(", ");
  return `rules=[${rulesSummary}] lifespan=${filter.lifespan} ownership=${filter.ownership}`;
}
