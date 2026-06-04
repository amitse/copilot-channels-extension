import path from "node:path";

export function isValidBaseCwd(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeBaseCwd(value, fallback) {
  if (isValidBaseCwd(value)) {
    return value;
  }

  if (isValidBaseCwd(fallback)) {
    return fallback;
  }

  return process.cwd();
}

export function resolveRequestedCwd(baseCwd, requestedCwd) {
  if (!requestedCwd) {
    return baseCwd;
  }

  return path.resolve(baseCwd, requestedCwd);
}
