import { DEFAULT_STREAM } from "./consts.mjs";
import { createSessionPort } from "./session/port.mjs";
import { createStreamStore } from "./streams/store.mjs";
import { createNotificationDispatcher } from "./streams/notifications.mjs";
import { createConfigStore } from "./config/store.mjs";
import { createEmitterSupervisor } from "./emitter/supervisor.mjs";
import { createTools } from "./tools/index.mjs";
import { createHooks } from "./hooks.mjs";
import { createProviderGateway } from "./provider/gateway.mjs";

export function createCopilotChannelsRuntime(options = {}) {
  let baseCwd = options.cwd ?? process.cwd();
  let cleanupSessionListeners = () => {};
  const resetSessionListeners = () => {
    cleanupSessionListeners();
    cleanupSessionListeners = () => {};
  };
  const getBaseCwd = () => baseCwd;
  const setBaseCwd = (next) => {
    if (typeof next === "string" && next.trim()) {
      baseCwd = next;
    }
  };

  process.stderr.write(`[tap-runtime] init — cwd=${baseCwd}\n`);
  const sessionPort = createSessionPort(options.session ?? null);
  const streams = createStreamStore();
  const configStore = createConfigStore({ cwd: baseCwd });
  process.stderr.write(`[tap-runtime] config loaded — cwd=${baseCwd}\n`);
  const notifications = createNotificationDispatcher({ sessionPort });
  const persist = () => configStore.save();
  const supervisor = createEmitterSupervisor({
    streams,
    configStore,
    notifications,
    sessionPort,
    getBaseCwd,
    persist
  });
  process.stderr.write(`[tap-runtime] supervisor ready\n`);

  const tools = createTools({ streams, configStore, supervisor, sessionPort, getBaseCwd, persist });
  const hooks = createHooks({ streams, configStore, supervisor, sessionPort, setBaseCwd });

  const tapToolsFn = () => tools;
  const gateway = createProviderGateway({
    sessionPort,
    tapTools: tapToolsFn,
    getSessionInfo: () => {
      const session = sessionPort.current();
      if (!session) return null;
      return { id: session.id ?? "default", label: session.label ?? "Copilot CLI", cwd: getBaseCwd() };
    },
    log: (msg) => {
      process.stderr.write(`[tap-gateway] ${msg}\n`);
      void sessionPort.log(msg);
    },
  });
  process.stderr.write(`[tap-runtime] gateway created\n`);

  // When provider tools change, re-register all tools and trigger extension reload
  gateway.onToolsChanged((mergedTools) => {
    sessionPort.registerTools(mergedTools);
    void sessionPort.reloadExtension();
  });

  const wireSessionListeners = (session) => {
    resetSessionListeners();

    const unsubscribers = [
      session.on("session.idle", () => {
        sessionPort.setIdle(true);
        supervisor.onSessionIdle();
      })
    ];

    for (const eventType of [
      "session.start",
      "session.resume",
      "user.message",
      "assistant.message",
      "tool.execution_start",
      "tool.execution_complete",
      "session.error"
    ]) {
      unsubscribers.push(session.on(eventType, () => {
        sessionPort.setIdle(false);
        supervisor.onSessionActivity();
      }));
    }

    cleanupSessionListeners = () => {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe?.();
        } catch {
          // Listener cleanup must never interrupt session attach.
        }
      }
    };
  };

  return {
    attachSession: (nextSession) => {
      process.stderr.write(`[tap-runtime] attachSession — id=${nextSession?.id ?? "(none)"}\n`);
      sessionPort.attach(nextSession);
      wireSessionListeners(nextSession);
      if (!gateway.isRunning()) {
        try {
          process.stderr.write(`[tap-runtime] starting gateway…\n`);
          gateway.start();
          process.stderr.write(`[tap-runtime] gateway started\n`);
        } catch (err) {
          process.stderr.write(`[tap-runtime] gateway start failed: ${err?.message ?? err}\n`);
          // Gateway startup must never block session attach
        }
      }
    },
    tools,
    hooks,
    stopAllEmitters: async () => {
      resetSessionListeners();
      gateway.stop();
      await supervisor.stopAll();
    },
    appendStreamMessage: (name, entry) => streams.append(name, entry),
    gateway,
    getTools: () => gateway.isRunning() ? gateway.getAllTools(tools) : tools,
    DEFAULT_STREAM
  };
}
