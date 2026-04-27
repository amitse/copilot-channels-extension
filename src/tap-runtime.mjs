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
  const getBaseCwd = () => baseCwd;
  const setBaseCwd = (next) => {
    baseCwd = next;
  };

  const sessionPort = createSessionPort(options.session ?? null);
  const streams = createStreamStore();
  const configStore = createConfigStore({ cwd: baseCwd });
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
    log: (msg) => void sessionPort.log(msg),
  });

  // When provider tools change, re-register all tools and trigger extension reload
  gateway.onToolsChanged((mergedTools) => {
    sessionPort.registerTools(mergedTools);
    void sessionPort.reloadExtension();
  });

  return {
    attachSession: (nextSession) => {
      sessionPort.attach(nextSession);
      if (!gateway.isRunning()) {
        try {
          gateway.start();
        } catch {
          // Gateway startup must never block session attach
        }
      }
    },
    tools,
    hooks,
    stopAllEmitters: async () => {
      gateway.stop();
      await supervisor.stopAll();
    },
    appendStreamMessage: (name, entry) => streams.append(name, entry),
    gateway,
    getTools: () => gateway.isRunning() ? gateway.getAllTools(tools) : tools,
    DEFAULT_STREAM
  };
}
