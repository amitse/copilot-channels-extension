import { createConfigStore } from "../config/store.mjs";
import { createEmitterSupervisor } from "../emitter/supervisor.mjs";
import { createSessionPort } from "../session/port.mjs";
import { createNotificationDispatcher } from "../streams/notifications.mjs";
import { createStreamStore } from "../streams/store.mjs";
import { normalizeBaseCwd } from "../util/path.mjs";

export function createRuntimeSubsystems(options = {}) {
  let baseCwd = normalizeBaseCwd(options.cwd ?? options.getBaseCwd?.());

  const getBaseCwd = () => baseCwd;
  const setBaseCwd = (next) => {
    baseCwd = normalizeBaseCwd(next, baseCwd);
    options.setBaseCwd?.(baseCwd);
    return baseCwd;
  };

  const sessionPort = options.sessionPort ?? createSessionPort(options.session ?? null);
  const streams = options.streams ?? createStreamStore();
  const configStore = options.configStore ?? createConfigStore({ cwd: baseCwd });
  const notifications = options.notifications ?? createNotificationDispatcher({ sessionPort });
  const persist = options.persist ?? (() => configStore.save());
  const supervisor = options.supervisor ?? createEmitterSupervisor({
    streams,
    configStore,
    notifications,
    sessionPort,
    getBaseCwd,
    persist
  });

  return {
    streams,
    configStore,
    supervisor,
    sessionPort,
    getBaseCwd,
    setBaseCwd,
    persist
  };
}
