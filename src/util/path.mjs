import path from "node:path";

export function resolveRequestedCwd(baseCwd, requestedCwd) {
  if (!requestedCwd) {
    return baseCwd;
  }

  return path.resolve(baseCwd, requestedCwd);
}
