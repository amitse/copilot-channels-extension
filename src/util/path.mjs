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
  const resolvedBaseCwd = normalizeBaseCwd(baseCwd);

  if (!requestedCwd) {
    return resolvedBaseCwd;
  }

  return path.resolve(resolvedBaseCwd, requestedCwd);
}
