import { LOG_PREFIX } from "../consts.mjs";
import { LifecycleError } from "../errors/index.mjs";

export function createSessionPort(initialSession = null) {
  let session = initialSession;
  let idle = false;

  function attach(nextSession) {
    session = nextSession ?? null;
    idle = false;
    return session;
  }

  function current() {
    return session;
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
    try {
      await session.log(message, options);
    } catch {
      // Logging must never interrupt the extension.
    }
  }

  async function log(message, options = {}) {
    await safeLog(`${LOG_PREFIX} ${message}`, {
      ephemeral: true,
      ...options
    });
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

  function registerTools(tools) {
    if (!session) return;
    try {
      session.registerTools(tools);
    } catch {
      // registerTools may not be available in all SDK versions
    }
  }

  async function reloadExtension() {
    if (!session) return;
    try {
      await session.rpc.extensions.reload();
    } catch {
      // extensions.reload is experimental and may not be available
    }
  }

  return {
    attach,
    current,
    setIdle,
    isIdle,
    log,
    send,
    sendAndWait,
    registerTools,
    reloadExtension
  };
}
