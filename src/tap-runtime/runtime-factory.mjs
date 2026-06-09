import { DEFAULT_STREAM, LOG_PREFIX } from "../consts.mjs";
import { createTools } from "../tools/index.mjs";
import { createHooks } from "../hooks.mjs";
import { createProviderGateway } from "../provider/gateway.mjs";
import { SESSION_LIFECYCLE_STATE } from "../provider/consts.mjs";
import { createTapRuntimeService } from "../services/tap-runtime-service.mjs";

const PROVIDER_SHUTDOWN_DEADLINE_MS = 10_000;
const EMITTER_SHUTDOWN_WAIT_TIMEOUT_MS = 10_000;

function logSessionShutdownWarning(session, error, detail) {
  try {
    void Promise.resolve(session?.log?.(`${LOG_PREFIX} Session shutdown cleanup failed: ${error?.message ?? detail}`, {
      ephemeral: true,
      level: "warning"
    })).catch(() => {});
  } catch {
    // Session logging may already be unavailable during shutdown.
  }
}

function logShutdownFailure(session, error) {
  const detail = error?.stack ?? error?.message ?? String(error ?? "unknown error");
  process.stderr.write(`[tap-runtime] session.shutdown cleanup failed: ${detail}\n`);
  logSessionShutdownWarning(session, error, detail);
}

export function createCopilotChannelsRuntime(options = {}) {
  let activeSession = options.session ?? null;
  const runtimeService = options.runtimeService ?? createTapRuntimeService({
    ...(options.runtimeServiceOptions ?? {}),
    cwd: options.cwd,
    session: options.session,
    shutdownSession: () => handleSessionShutdown(activeSession)
  });
  process.stderr.write(`[tap-runtime] init — cwd=${runtimeService.session.getBaseCwd()}\n`);

  const tools = createTools({ tools: runtimeService.tools });
  const hooks = createHooks({ runtime: runtimeService.hooks });

  const tapToolsFn = () => tools;
  const gateway = options.gateway ?? createProviderGateway({
    tapTools: tapToolsFn,
    getSessionInfo: runtimeService.provider.getSessionInfo,
    deliverPush: runtimeService.provider.deliverPush,
    log: runtimeService.provider.log
  });
  process.stderr.write(`[tap-runtime] gateway created\n`);

  // When provider tools change, re-register all tools and trigger extension reload
  gateway.onToolsChanged(runtimeService.provider.replaceSessionTools);
  let cleanupShutdownListener = () => {};
  let shutdownListenerGeneration = 0;
  let shutdownRecord = null;

  function clearShutdownListener() {
    shutdownListenerGeneration += 1;
    try {
      cleanupShutdownListener();
    } catch {
      // Listener cleanup must not interrupt reload/attach.
    }
    cleanupShutdownListener = () => {};
  }

  function registerShutdownListener(session) {
    clearShutdownListener();
    if (!session || typeof session.on !== "function") {
      return;
    }

    const generation = shutdownListenerGeneration;
    let handled = false;
    const unsubscribe = session.on("session.shutdown", () => {
      if (handled || generation !== shutdownListenerGeneration) {
        return;
      }
      handled = true;
      process.stderr.write("[tap-runtime] session.shutdown received — stopping runtime\n");
      void handleSessionShutdown(session).catch((error) => {
        logShutdownFailure(session, error);
      });
    });

    cleanupShutdownListener = () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }

  async function stopAllEmitters(options = {}) {
    gateway.stop();
    return await runtimeService.session.stopAllEmitters(options);
  }

  async function stopAllEmittersAndWait(options = {}) {
    gateway.stop();
    if (typeof runtimeService.session.stopAllEmittersAndWait === "function") {
      return await runtimeService.session.stopAllEmittersAndWait(options);
    }
    return await runtimeService.session.stopAllEmitters(options);
  }

  async function performSessionShutdown(session) {
    if (gateway.isRunning()) {
      const sessionId = session?.id ?? "default";
      gateway.broadcastLifecycle(
        sessionId,
        SESSION_LIFECYCLE_STATE.SHUTDOWN_PENDING,
        PROVIDER_SHUTDOWN_DEADLINE_MS
      );
    }
    gateway.stop();
    if (typeof runtimeService.session.stopAllEmittersAndWait === "function") {
      return await runtimeService.session.stopAllEmittersAndWait({
        timeoutMs: EMITTER_SHUTDOWN_WAIT_TIMEOUT_MS,
        clearNotifications: true,
        clearReason: "session-shutdown"
      });
    }
    return await runtimeService.session.stopAllEmitters({
      clearNotifications: true,
      clearReason: "session-shutdown"
    });
  }

  function handleSessionShutdown(session = activeSession) {
    const targetSession = session ?? activeSession ?? null;
    if (shutdownRecord?.session === targetSession) {
      return shutdownRecord.promise;
    }

    const record = {
      session: targetSession,
      settled: false,
      promise: null
    };
    record.promise = (async () => {
      try {
        return await performSessionShutdown(targetSession);
      } finally {
        record.settled = true;
      }
    })();
    shutdownRecord = record;
    return record.promise;
  }

  function startGatewayIfNeeded() {
    if (gateway.isRunning()) {
      return;
    }

    try {
      process.stderr.write(`[tap-runtime] starting gateway…\n`);
      gateway.start();
      process.stderr.write(`[tap-runtime] gateway started\n`);
    } catch (err) {
      process.stderr.write(`[tap-runtime] gateway start failed: ${err?.message ?? err}\n`);
      // Gateway startup must never block session attach
    }
  }

  function attachSession(nextSession) {
    process.stderr.write(`[tap-runtime] attachSession — id=${nextSession?.id ?? "(none)"}\n`);
    activeSession = nextSession ?? null;
    if (shutdownRecord?.settled) {
      shutdownRecord = null;
    }
    runtimeService.session.attachSession(nextSession);
    registerShutdownListener(nextSession);
    startGatewayIfNeeded();
  }

  return {
    attachSession,
    tools,
    hooks,
    stopAllEmitters,
    stopAllEmittersAndWait,
    handleSessionShutdown,
    appendStreamMessage: runtimeService.session.appendStreamMessage,
    getTools: () => gateway.isRunning() ? gateway.getAllTools(tools) : tools,
    DEFAULT_STREAM
  };
}
