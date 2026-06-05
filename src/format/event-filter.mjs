import { OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";

export function createEventFilter(source = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  return EventFilterService.normalize(source, fallbackOwnership, fallbackLifespan);
}

export function evaluateEventFilter(filter, text) {
  return EventFilterService.evaluate(filter, text);
}

export function getEventFilterInput(source = {}) {
  return EventFilterService.getInput(source);
}

export function formatEventFilter(filter) {
  return EventFilterService.format(filter);
}
