import { createSessionActivityBridge } from "../session/listeners.mjs";
import { createConfigBootstrapService } from "./config-bootstrap-service.mjs";
import { createEmitterService } from "./emitter-service.mjs";
import { createProviderPushService } from "./provider-push-service.mjs";
import { createRuntimeHooks } from "./runtime-hooks.mjs";
import { createRuntimeSubsystems } from "./runtime-subsystems.mjs";
import { createStreamService } from "./stream-service.mjs";
import { createDiagnosticsStore } from "../diagnostics/store.mjs";
import { nowIso } from "../util/time.mjs";
import { TAP_DIAGNOSTICS_CANVAS_ID } from "../canvas/consts.mjs";

function trimStreamEntries(stream, limit) {
  const entryLimit = Math.max(0, Math.floor(Number(limit ?? 80) || 80));
  return {
    ...stream,
    entries: Array.isArray(stream.entries)
      ? stream.entries.slice(Math.max(0, stream.entries.length - entryLimit))
      : []
  };
}

function projectToolForDiagnostics(tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    providerId: tool.providerId ?? null,
    providerName: tool.providerName ?? null,
    skipPermission: tool.skipPermission === true,
    overridesBuiltInTool: tool.overridesBuiltInTool === true
  };
}

export function createTapRuntimeService(options = {}) {
  const diagnosticsStore = options.diagnostics ?? createDiagnosticsStore();
  const {
    streams,
    configStore,
    notifications,
    supervisor,
    sessionPort,
    sessionContext,
    configWorkspace,
    emitterWorkspace,
    persist
  } = createRuntimeSubsystems(options);
  const streamService = createStreamService({
    streams,
    configStore,
    sessionPort,
    persist
  });
  const emitterService = createEmitterService({
    streams,
    configStore,
    supervisor,
    emitterWorkspace
  });
  const configBootstrapService = createConfigBootstrapService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    configWorkspace
  });
  const { loadPersistentConfig } = configBootstrapService;
  const sessionActivityBridge = createSessionActivityBridge({ sessionPort, supervisor });
  const providerPushService = createProviderPushService({
    streams,
    notifications,
    sessionPort
  });
  const shutdownSession = options.shutdownSession;

  function getSessionInfo() {
    const session = sessionPort.current();
    return sessionContext.getSessionInfo(session);
  }

  function attachSession(session) {
    sessionContext.attachSession(session);
    sessionPort.attach(session);
    // Keep bridge attach after port attach: the bridge may synthesize the
    // initial idle lifecycle nudge for emitters started during hook startup.
    sessionActivityBridge.attach(session);
    diagnosticsStore.attachSession(session);
  }

  function clearNotificationsForLifecycle(options = {}) {
    if (options.clearNotifications === true && typeof notifications.clear === "function") {
      notifications.clear({
        reason: options.clearReason ?? "session-shutdown",
        generation: true
      });
    }
  }

  async function stopAllEmitters(options = {}) {
    sessionActivityBridge.detach();
    try {
      await supervisor.stopAll();
      return [];
    } finally {
      clearNotificationsForLifecycle(options);
    }
  }

  async function stopAllEmittersAndWait(options = {}) {
    sessionActivityBridge.detach();
    try {
      if (typeof supervisor.stopAllAndWait === "function") {
        return await supervisor.stopAllAndWait(options);
      }
      await supervisor.stopAll();
      return [];
    } finally {
      clearNotificationsForLifecycle(options);
    }
  }

  function appendStreamMessage(name, entry) {
    return streams.append(name, entry);
  }

  const streamCapabilities = {
    listStreams: () => streamService.listStreams(),
    postToStream: (input) => streamService.postToStream(input),
    getStreamHistory: (channel, limit) => streamService.getStreamHistory(channel, limit),
    setInjectorPolicy: (name, policy) => streamService.setInjectorPolicy(name, policy),
    getStreamState: (name) => streamService.getStreamState(name)
  };

  const emitterCapabilities = {
    listEmitters: () => emitterService.listEmitters(),
    startEmitter: (spec, options = {}) => emitterService.startEmitter(spec, options),
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
    stopAllEmittersAndWait,
    shutdownSession,
    listStreams: streamCapabilities.listStreams,
    listEmitters: emitterCapabilities.listEmitters
  });

  const sessionCapabilities = {
    attachSession,
    stopAllEmitters,
    stopAllEmittersAndWait,
    appendStreamMessage,
    getSessionInfo,
    getBaseCwd: sessionContext.getBaseCwd
  };

  const providerCapabilities = {
    getSessionInfo,
    log: (msg) => {
      diagnosticsStore.log("gateway", msg);
      process.stderr.write(`[tap-gateway] ${msg}\n`);
      void sessionPort.log(msg);
    },
    deliverPush: (provider, push) => providerPushService.deliverPush(provider, push),
    replaceSessionTools: (mergedTools) => {
      sessionPort.registerTools(mergedTools);
      void sessionPort.reloadExtension();
    }
  };

  function getDiagnosticsSnapshot(options = {}, extra = {}) {
    const allTools = Array.isArray(extra.tools) ? extra.tools.map(projectToolForDiagnostics) : [];
    return {
      generatedAt: nowIso(),
      session: getSessionInfo(),
      baseCwd: sessionContext.getBaseCwd(),
      process: {
        pid: process.pid,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime())
      },
      streams: streamCapabilities.listStreams().map((stream) => trimStreamEntries(stream, options.streamEntryLimit)),
      emitters: emitterCapabilities.listEmitters(),
      gateway: extra.gateway ?? null,
      tools: allTools,
      notifications: typeof notifications.snapshot === "function"
        ? notifications.snapshot({ limit: options.notificationLimit ?? 20 })
        : null,
      diagnostics: diagnosticsStore.snapshot(options)
    };
  }

  const diagnosticsCapabilities = {
    log: (source, message, options = {}) => diagnosticsStore.log(source, message, options),
    event: (type, message, metadata = {}) => diagnosticsStore.event(type, message, metadata),
    snapshot: getDiagnosticsSnapshot,
    openCanvas: async (input = {}) => {
      const instanceId = String(input.instanceId ?? TAP_DIAGNOSTICS_CANVAS_ID).trim() || TAP_DIAGNOSTICS_CANVAS_ID;
      const limit = Number(input.limit);
      const canvasInput = Number.isFinite(limit)
        ? { limit: Math.max(10, Math.min(300, Math.floor(limit))) }
        : {};
      diagnosticsStore.event("canvas.open.requested", "Opening tap diagnostics canvas.", { instanceId, canvasInput });
      return sessionPort.openCanvas({
        canvasId: TAP_DIAGNOSTICS_CANVAS_ID,
        instanceId,
        input: canvasInput
      });
    },
    attachSession: diagnosticsStore.attachSession,
    detachSession: diagnosticsStore.detachSession
  };

  return {
    tools: {
      streams: streamCapabilities,
      emitters: emitterCapabilities,
      diagnostics: diagnosticsCapabilities
    },
    hooks: hookCapabilities,
    session: sessionCapabilities,
    provider: providerCapabilities,
    diagnostics: diagnosticsCapabilities,
    getBaseCwd: sessionContext.getBaseCwd,
    getSessionInfo,
    attachSession,
    stopAllEmitters,
    stopAllEmittersAndWait,
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