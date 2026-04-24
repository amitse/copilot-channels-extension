import { DEFAULT_CHANNEL } from "./consts.mjs";
import { createSessionPort } from "./session/port.mjs";
import { createChannelStore } from "./channels/store.mjs";
import { createNotificationDispatcher } from "./channels/notifications.mjs";
import { createConfigStore } from "./config/store.mjs";
import { createMonitorSupervisor } from "./monitor/supervisor.mjs";
import { createTools } from "./tools/index.mjs";
import { createHooks } from "./hooks.mjs";

export function createCopilotChannelsRuntime(options = {}) {
  let baseCwd = options.cwd ?? process.cwd();
  const getBaseCwd = () => baseCwd;
  const setBaseCwd = (next) => {
    baseCwd = next;
  };

  const sessionPort = createSessionPort(options.session ?? null);
  const channels = createChannelStore();
  const configStore = createConfigStore({ cwd: baseCwd });
  const notifications = createNotificationDispatcher({ sessionPort });
  const persist = () => configStore.save();
  const supervisor = createMonitorSupervisor({
    channels,
    configStore,
    notifications,
    sessionPort,
    getBaseCwd,
    persist
  });

  const tools = createTools({ channels, configStore, supervisor, sessionPort, getBaseCwd, persist });
  const hooks = createHooks({ channels, configStore, supervisor, sessionPort, setBaseCwd });

  return {
    attachSession: (nextSession) => sessionPort.attach(nextSession),
    tools,
    hooks,
    stopAllMonitors: () => supervisor.stopAll(),
    appendChannelMessage: (name, entry) => channels.append(name, entry),
    DEFAULT_CHANNEL
  };
}
