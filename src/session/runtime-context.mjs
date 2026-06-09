import { normalizeBaseCwd, resolveRequestedCwd } from "../util/path.mjs";

const DEFAULT_SESSION_ID = "default";
const DEFAULT_SESSION_LABEL = "Copilot CLI";

function hasExplicitValue(value) {
  return value !== undefined && value !== null;
}

/**
 * Runtime-owned boundary for the Copilot session/workspace context.
 *
 * This is intentionally smaller than a runtime bag: callers receive only the
 * capability view they need (config cwd mutation or emitter cwd resolution),
 * while the mutable base/config cwd values remain owned in one place.
 */
export function createRuntimeSessionContext(options = {}) {
  let sessionId = options.sessionId ?? options.session?.id ?? DEFAULT_SESSION_ID;
  let sessionLabel = options.sessionLabel ?? options.session?.label ?? DEFAULT_SESSION_LABEL;
  let baseCwd = normalizeBaseCwd(options.cwd ?? options.baseCwd);
  let configCwd = normalizeBaseCwd(options.configCwd, baseCwd);

  function getBaseCwd() {
    return baseCwd;
  }

  function getSessionCwd() {
    return baseCwd;
  }

  function getConfigCwd() {
    return configCwd;
  }

  function resolveBaseCwd(inputCwd) {
    return normalizeBaseCwd(inputCwd, baseCwd);
  }

  function commitConfigCwd(nextCwd) {
    const resolvedCwd = normalizeBaseCwd(nextCwd, baseCwd);
    baseCwd = resolvedCwd;
    configCwd = resolvedCwd;
    return resolvedCwd;
  }

  function attachSession(session) {
    sessionId = session?.id ?? DEFAULT_SESSION_ID;
    sessionLabel = session?.label ?? DEFAULT_SESSION_LABEL;
    return session;
  }

  function getSessionInfo(session) {
    if (!session) {
      return null;
    }

    return {
      id: session.id ?? sessionId ?? DEFAULT_SESSION_ID,
      label: session.label ?? sessionLabel ?? DEFAULT_SESSION_LABEL,
      cwd: getBaseCwd()
    };
  }

  function resolveEmitterBaseCwd(requestedBaseCwd) {
    // Preserve the previous nullish-only fallback semantics for emitter starts:
    // undefined/null use the active session cwd, while an explicit blank string
    // is normalized by normalizeBaseCwd itself (which falls back to process.cwd).
    return hasExplicitValue(requestedBaseCwd)
      ? normalizeBaseCwd(requestedBaseCwd)
      : getBaseCwd();
  }

  function createEmitterWorkspace(options = {}) {
    const resolvedBaseCwd = resolveEmitterBaseCwd(options.baseCwd);

    return Object.freeze({
      baseCwd: resolvedBaseCwd,
      resolveEmitterCwd: (requestedCwd) => resolveRequestedCwd(resolvedBaseCwd, requestedCwd)
    });
  }

  function resolveEmitterCwd(requestedCwd, options = {}) {
    return createEmitterWorkspace(options).resolveEmitterCwd(requestedCwd);
  }

  const configWorkspace = Object.freeze({
    resolveBaseCwd,
    commitConfigCwd,
    getConfigCwd
  });

  const emitterWorkspace = Object.freeze({
    createEmitterWorkspace,
    resolveEmitterCwd,
    getBaseCwd
  });

  return Object.freeze({
    attachSession,
    getSessionInfo,
    getBaseCwd,
    getSessionCwd,
    getConfigCwd,
    resolveBaseCwd,
    commitConfigCwd,
    createEmitterWorkspace,
    resolveEmitterCwd,
    configWorkspace,
    emitterWorkspace
  });
}
