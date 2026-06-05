import { createConfigStore } from "../config/store.mjs";
import { createEmitterSupervisor } from "../emitter/supervisor.mjs";
import { createSessionActivityBridge } from "../session/listeners.mjs";
import { createSessionPort } from "../session/port.mjs";
import { createNotificationDispatcher } from "../streams/notifications.mjs";
import { createStreamStore } from "../streams/store.mjs";
import { normalizeBaseCwd } from "../util/path.mjs";
import { createConfigBootstrapService } from "./config-bootstrap-service.mjs";
import { createEmitterService } from "./emitter-service.mjs";
import { createRuntimeHooks } from "./runtime-hooks.mjs";

function createRuntimeSubsystems(options = {}) {
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

export function createTapRuntimeService(options = {}) {
  const {
    streams,
    configStore,
    supervisor,
    sessionPort,
    getBaseCwd,
    setBaseCwd,
    persist
  } = createRuntimeSubsystems(options);
  const emitterService = createEmitterService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    getBaseCwd,
    persist
  });
  const configBootstrapService = createConfigBootstrapService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    setBaseCwd
  });
  const { loadPersistentConfig } = configBootstrapService;
  const sessionActivityBridge = createSessionActivityBridge({ sessionPort, supervisor });

  function getSessionInfo() {
    const session = sessionPort.current();
    if (!session) return null;
    return { id: session.id ?? "default", label: session.label ?? "Copilot CLI", cwd: getBaseCwd() };
  }

  function attachSession(session) {
    sessionPort.attach(session);
    sessionActivityBridge.attach(session);
  }

  async function stopAllEmitters() {
    sessionActivityBridge.detach();
    await supervisor.stopAll();
  }

  function appendStreamMessage(name, entry) {
    return streams.append(name, entry);
  }

  const streamCapabilities = {
    listStreams: () => emitterService.listStreams(),
    postToStream: (input) => emitterService.postToStream(input),
    getStreamHistory: (channel, limit) => emitterService.getStreamHistory(channel, limit),
    // Session injector policy is stream-facing even though persistence is coordinated
    // through the emitter service.
    setInjectorPolicy: (name, policy) => emitterService.setInjectorPolicy(name, policy),
    getStreamState: (name) => emitterService.getStreamState(name)
  };

  const emitterCapabilities = {
    listEmitters: () => emitterService.listEmitters(),
    startEmitter: (spec, options = {}) => emitterService.startEmitter(spec, { ...options, baseCwd: options.baseCwd ?? getBaseCwd() }),
    stopEmitter: (name, options = {}) => emitterService.stopEmitter(name, options),
    updateFilter: (name, filter, options = {}) => emitterService.updateFilter(name, filter, options),
    getEmitterState: (name) => emitterService.getEmitterState(name)
  };

  const {
    hooks: hookCapabilities,
    getSessionStartContext,
    getPromptContext
  } = createRuntimeHooks({
    streams,
    sessionPort,
    loadPersistentConfig,
    stopAllEmitters,
    listStreams: streamCapabilities.listStreams,
    listEmitters: emitterCapabilities.listEmitters
  });

  const sessionCapabilities = {
    attachSession,
    stopAllEmitters,
    appendStreamMessage,
    getSessionInfo,
    getBaseCwd
  };

  const providerCapabilities = {
    getSessionInfo,
    log: (msg) => {
      process.stderr.write(`[tap-gateway] ${msg}\n`);
      void sessionPort.log(msg);
    },
    replaceSessionTools: (mergedTools) => {
      sessionPort.registerTools(mergedTools);
      void sessionPort.reloadExtension();
    }
  };

  return {
    tools: {
      streams: streamCapabilities,
      emitters: emitterCapabilities
    },
    hooks: hookCapabilities,
    session: sessionCapabilities,
    provider: providerCapabilities,
    getBaseCwd,
    getSessionInfo,
    attachSession,
    stopAllEmitters,
    appendStreamMessage,
    getSessionStartContext,
    getPromptContext,
    loadPersistentConfig,
    listEmitters: emitterCapabilities.listEmitters,
    listStreams: streamCapabilities.listStreams,
    postToStream: streamCapabilities.postToStream,
    getStreamHistory: streamCapabilities.getStreamHistory,
    startEmitter: emitterCapabilities.startEmitter,
    stopEmitter: emitterCapabilities.stopEmitter,
    updateFilter: emitterCapabilities.updateFilter,
    setInjectorPolicy: streamCapabilities.setInjectorPolicy,
    getEmitterState: emitterCapabilities.getEmitterState,
    getStreamState: streamCapabilities.getStreamState
  };
}