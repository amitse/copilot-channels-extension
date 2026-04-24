import { createChannelTools } from "./channels.mjs";
import { createMonitorTools } from "./monitors.mjs";

export function createTools(deps) {
  return [
    ...createChannelTools(deps),
    ...createMonitorTools(deps)
  ];
}
