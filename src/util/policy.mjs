import { MANAGED_BY, TERMINAL_MONITOR_STATUSES } from "../consts.mjs";
import { normalizeManagedBy } from "./normalize.mjs";

// User-managed entries are treated as protected unless the caller explicitly forces the change.
export function assertMutable(managedBy, force, label) {
  if (normalizeManagedBy(managedBy, MANAGED_BY.MODEL) === MANAGED_BY.USER && !force) {
    throw new Error(`${label} is user-controlled. Pass force=true only when the user explicitly wants to override it.`);
  }
}

export function isTerminalMonitorStatus(status) {
  return TERMINAL_MONITOR_STATUSES.includes(status);
}
