import { LOG_PREFIX } from "../consts.mjs";

export function createSessionPort(initialSession = null) {
  let session = initialSession;

  function attach(nextSession) {
    session = nextSession ?? null;
    return session;
  }

  function current() {
    return session;
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
      throw new Error("Session is not attached; cannot send prompt.");
    }
    return session.send({ prompt });
  }

  async function sendAndWait(prompt) {
    if (!session) {
      throw new Error("Session is not attached; cannot send prompt.");
    }
    return session.sendAndWait({ prompt });
  }

  return {
    attach,
    current,
    log,
    send,
    sendAndWait
  };
}
