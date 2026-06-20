import { LOG_PREFIX } from "../consts.mjs";
import { LifecycleError } from "../errors/index.mjs";

const MAX_PENDING_LOGS = 100;

function formatDiagnosticError(error) {
  if (error && typeof error === "object" && "message" in error && error.message) {
    return String(error.message);
  }
  return String(error);
}

function writeDiagnostic(operation, error) {
  try {
    process.stderr.write(`[tap] ${operation} failed: ${formatDiagnosticError(error)}\n`);
  } catch {
    // Diagnostics must never interrupt the extension lifecycle.
  }
}

export function createSessionPort(initialSession = null) {
  let session = initialSession;
  let idle = false;
  const pendingLogs = [];

  function enqueueLog(message, options) {
    if (pendingLogs.length >= MAX_PENDING_LOGS) {
      pendingLogs.shift();
    }
    pendingLogs.push({ message, options });
  }

  async function deliverLog(targetSession, message, options) {
    if (!targetSession) {
      return;
    }
    try {
      await targetSession.log(message, options);
    } catch {
      // Logging must never interrupt the extension.
    }
  }

  async function flushPendingLogs(targetSession, entries) {
    for (const entry of entries) {
      await deliverLog(targetSession, entry.message, entry.options);
    }
  }

  function attach(nextSession) {
    const previousSession = session;
    session = nextSession ?? null;
    idle = false;
    const queuedLogs = pendingLogs.splice(0);
    if (session && !previousSession && queuedLogs.length > 0) {
      void flushPendingLogs(session, queuedLogs);
    }
    return session;
  }

  function current() {
    return session;
  }

  function isAttached() {
    return Boolean(session);
  }

  function setIdle(nextIdle) {
    idle = nextIdle === true;
  }

  function isIdle() {
    return Boolean(session) && idle === true;
  }

  async function safeLog(message, options) {
    if (!session) {
      return;
    }
    await deliverLog(session, message, options);
  }

  async function log(message, options = {}) {
    const payload = {
      message: `${LOG_PREFIX} ${message}`,
      options: {
        ephemeral: true,
        ...options
      }
    };

    if (!session) {
      enqueueLog(payload.message, payload.options);
      return;
    }

    await safeLog(payload.message, payload.options);
  }

  async function send(prompt) {
    if (!session) {
      throw new LifecycleError("Session is not attached; cannot send prompt.");
    }
    return session.send({ prompt });
  }

  async function sendAndWait(prompt) {
    if (!session) {
      throw new LifecycleError("Session is not attached; cannot send prompt.");
    }
    return session.sendAndWait({ prompt });
  }

  async function openCanvas(params) {
    if (!session) {
      throw new LifecycleError("Session is not attached; cannot open canvas.");
    }
    const canvasApi = session.rpc?.canvas;
    if (!canvasApi || typeof canvasApi.open !== "function") {
      throw new LifecycleError("Canvas renderer API is not available in this Copilot session.");
    }
    return canvasApi.open(params);
  }

  function registerTools(tools) {
    if (!session) return;
    try {
      const register = session.registerTools;
      if (typeof register !== "function") {
        return;
      }
      const result = register.call(session, tools);
      void Promise.resolve(result).catch((err) => writeDiagnostic("registerTools", err));
    } catch (err) {
      writeDiagnostic("registerTools", err);
    }
  }

  async function reloadExtension() {
    if (!session) return;
    try {
      const extensions = session.rpc?.extensions;
      const reload = extensions?.reload;
      if (typeof reload !== "function") {
        return;
      }
      await reload.call(extensions);
    } catch (err) {
      writeDiagnostic("extensions.reload", err);
    }
  }

  return {
    attach,
    current,
    isAttached,
    setIdle,
    isIdle,
    log,
    send,
    sendAndWait,
    openCanvas,
    registerTools,
    reloadExtension
  };
}
