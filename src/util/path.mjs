import path from "node:path";

import { ValidationError } from "../errors/index.mjs";

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

function isAbsoluteRequestedCwd(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function isWithinBaseCwd(baseCwd, resolvedCwd) {
  const relative = path.relative(baseCwd, resolvedCwd);

  return relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
}

export function resolveRequestedCwd(baseCwd, requestedCwd) {
  const normalizedBaseCwd = normalizeBaseCwd(baseCwd);
  const resolvedBaseCwd = path.resolve(normalizedBaseCwd);
  const requestedText = String(requestedCwd ?? "").trim();

  if (!requestedText || requestedText === ".") {
    return normalizedBaseCwd;
  }

  if (isAbsoluteRequestedCwd(requestedText)) {
    throw new ValidationError("Invalid emitter cwd: absolute paths are not allowed; use a path relative to the session cwd.", {
      context: { baseCwd: resolvedBaseCwd, requestedCwd: requestedText }
    });
  }

  const resolvedCwd = path.resolve(resolvedBaseCwd, requestedText);
  if (!isWithinBaseCwd(resolvedBaseCwd, resolvedCwd)) {
    throw new ValidationError("Invalid emitter cwd: path must stay within the session cwd.", {
      context: { baseCwd: resolvedBaseCwd, requestedCwd: requestedText, resolvedCwd }
    });
  }

  return resolvedCwd;
}
