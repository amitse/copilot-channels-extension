import { DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION, EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeEmitterStreamInputTolerant as normalizeEmitterStreamInput } from "../contracts/emitter-input.mjs";
import { normalizeStartScopeAndOwnership } from "../emitter/start-options.mjs";
import { hasExplicitPersistentSessionInjector } from "../streams/store.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { isTerminalEmitterStatus } from "../util/policy.mjs";

export function createConfigBootstrapService({ streams, configStore, supervisor, sessionPort, configWorkspace }) {
  function isConfiguredSessionInjector(stream) {
    const injector = stream?.sessionInjector;
    if (!injector) {
      return false;
    }

    return injector.enabled === true ||
      injector.delivery !== EVENT_OUTCOME.SURFACE;
  }

  function hasExplicitSessionInjector(entry) {
    return hasExplicitPersistentSessionInjector(entry);
  }

  function configuredSessionInjectorStreams(streamEntries) {
    return new Set(
      streamEntries
        .filter((entry) => hasExplicitSessionInjector(entry))
        .map((entry) => normalizeName(entry.name))
        .filter(Boolean)
    );
  }

  function resolveAutoStartSubscription(entry, configuredInjectorStreams) {
    if (entry?.subscribe === false) {
      return { subscribe: false };
    }

    const streamName = normalizeEmitterStreamInput(entry, entry?.name);
    if (configuredInjectorStreams.has(streamName)) {
      return { preserveExistingSessionInjector: true };
    }

    const existingStream = typeof streams.get === "function" && streamName
      ? streams.get(streamName)
      : null;
    if (isConfiguredSessionInjector(existingStream)) {
      return { preserveExistingSessionInjector: true };
    }

    return entry?.subscribe === true ? { subscribe: true } : {};
  }

  async function loadPersistentConfig(inputCwd) {
    const resolvedBaseCwd = configWorkspace.resolveBaseCwd(inputCwd);

    const configLoad = configStore.load(resolvedBaseCwd);
    const committedBaseCwd = configWorkspace.commitConfigCwd(configStore.getCwd?.() ?? resolvedBaseCwd);
    streams.ensure(DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION);
    const streamEntries = configStore.getStreams();
    const configuredInjectorStreams = configuredSessionInjectorStreams(streamEntries);

    for (const entry of streamEntries) {
      streams.applyPersistentStream(entry);
    }

    let started = 0;
    let alreadyRunning = 0;
    for (const entry of configStore.getEmitters()) {
      if (entry.autoStart === false) {
        continue;
      }

      const existing = supervisor.get(entry.name);
      if (existing && !isTerminalEmitterStatus(existing.status)) {
        alreadyRunning += 1;
        continue;
      }

      try {
        const startPolicy = normalizeStartScopeAndOwnership(
          { scope: LIFESPAN.PERSISTENT, managedBy: entry.ownership },
          { scope: LIFESPAN.PERSISTENT, managedBy: OWNERSHIP.USER_OWNED }
        );
        const subscription = resolveAutoStartSubscription(entry, configuredInjectorStreams);
        const startOptions = {
          baseCwd: committedBaseCwd,
          scope: startPolicy.scope,
          managedBy: startPolicy.managedBy,
          force: true,
          persistConfig: false
        };
        if (subscription.subscribe !== undefined) {
          startOptions.subscribe = subscription.subscribe;
        }
        if (subscription.preserveExistingSessionInjector === true) {
          startOptions.preserveExistingSessionInjector = true;
        }

        await supervisor.start(
          {
            ...entry,
            scope: startPolicy.scope,
            managedBy: startPolicy.managedBy
          },
          startOptions
        );
        started += 1;
      } catch (error) {
        await sessionPort.log(`Failed to auto-start emitter '${entry.name}': ${error.message}`, {
          level: "warning"
        });
      }
    }

    const alreadyRunningSummary = alreadyRunning > 0 ? ` Already running ${alreadyRunning}.` : "";

    return configLoad.found
      ? `Loaded ${configStore.getStreams().length} event streams and ${configStore.getEmitters().length} persistent emitter definitions from ${configLoad.filePath}. Auto-started ${started}.${alreadyRunningSummary}`
      : "No copilot-channels config file found.";
  }

  return {
    loadPersistentConfig
  };
}
