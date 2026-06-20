import { createConfigStore } from "../config/store.mjs";
import { createEmitterSupervisor } from "../emitter/supervisor.mjs";
import { createSessionPort } from "../session/port.mjs";
import { createRuntimeSessionContext } from "../session/runtime-context.mjs";
import { createNotificationDispatcher } from "../streams/notifications.mjs";
import { createStreamStore } from "../streams/store.mjs";

export function createRuntimeSubsystems(options = {}) {
  const sessionContext = options.sessionContext ?? options.runtimeSessionContext ?? createRuntimeSessionContext({
    cwd: options.cwd,
    session: options.session
  });
  const { configWorkspace, emitterWorkspace } = sessionContext;

  const sessionPort = options.sessionPort ?? createSessionPort(options.session ?? null);
  const streams = options.streams ?? createStreamStore();
  const configStore = options.configStore ?? createConfigStore({ cwd: sessionContext.getConfigCwd() });
  const notifications = options.notifications ?? createNotificationDispatcher({ sessionPort });
  const persist = options.persist ?? (() => configStore.save());
  const supervisor = options.supervisor ?? createEmitterSupervisor({
    streams,
    configStore,
    notifications,
    sessionPort,
    emitterWorkspace,
    persist,
    diagnostics: options.diagnostics
  });

  return {
    sessionContext,
    configWorkspace,
    emitterWorkspace,
    streams,
    configStore,
    notifications,
    supervisor,
    sessionPort,
    persist
  };
}
