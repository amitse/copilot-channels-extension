import { EventFilterService } from "../event-filter/service.mjs";

export function formatEventFilter(filter) {
  return EventFilterService.format(filter);
}
