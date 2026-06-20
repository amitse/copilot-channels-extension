import { EMITTER_OPERATION_STATUS, EMITTER_STATUS, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeName, normalizeLifespan, normalizeOwnership } from "../util/normalize.mjs";
import { assertMutable, isTerminalEmitterStatus } from "../util/policy.mjs";
import { formatEventFilter } from "../format/event-filter.mjs";
import { formatSessionInjectorPolicyLog } from "../format/stream.mjs";
import { normalizeEmitterSpec } from "./spec.mjs";
import { buildEmitterState } from "./state.mjs";
import { createLineRouter } from "./line-router.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { ConflictError, LifecycleError, NotFoundError, AppError } from "../errors/index.mjs";
import { cloneConfigEntry, restorePersistentStreamConfig, snapshotPersistentStreamConfig } from "../config/transaction-snapshots.mjs";

const ROLLBACK_STOP_WAIT_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} SupervisorDeps
 * @property {Object} streams - Event stream manager
 * @property {Object} configStore - Persistent config storage
 * @property {Object} notifications - Notification dispatcher for event injection
 * @property {Object} sessionPort - Session logging interface
 * @property {Object} emitterWorkspace - Runtime workspace capability for emitter cwd resolution
 * @property {Function} persist - Function to persist config
 * @property {Object} [lifecycle] - Optional lifecycle adapter seam for tests
 * @property {Object} [diagnostics] - Optional diagnostics recorder
 */

/**
 * Create emitter supervisor with minimal dependency injection.
 * @param {SupervisorDeps} deps
 */
export function createEmitterSupervisor({ streams, configStore, notifications, sessionPort, emitterWorkspace, persist, lifecycle: lifecycleOverride, diagnostics = null }) {
  const emitters = new Map();
  const lineRouter = createLineRouter({
    streams,
    notifications,
    surface: (message, options) => sessionPort.log(message, options)
  });
  const lifecycle = lifecycleOverride ?? createLifecycle({ lineRouter, sessionPort, diagnostics });

  function hasExplicitPolicyValue(value) {
    return value !== undefined && value !== null;
  }

  function eventFilterUpdateInput(input, options = {}) {
    const changes = input && typeof input === "object" && !Array.isArray(input)
      ? { ...input }
      : {};

    if (hasExplicitPolicyValue(options.ownership ?? options.managedBy)) {
      changes.ownership = normalizeOwnership(options.ownership ?? options.managedBy, OWNERSHIP.MODEL_OWNED);
    }
    if (hasExplicitPolicyValue(options.lifespan ?? options.scope)) {
      changes.lifespan = normalizeLifespan(options.lifespan ?? options.scope, LIFESPAN.TEMPORARY);
    }

    return changes;
  }

  function normalizeConfiguredEmitterOwnership(configEntry) {
    return normalizeOwnership(
      configEntry?.ownership ?? configEntry?.managedBy,
      OWNERSHIP.USER_OWNED
    );
  }

  function assertPersistentConfigEmitterMutable(name, configEntry, force, options = {}) {
    if (!configEntry) {
      return;
    }

    assertMutable(
      normalizeConfiguredEmitterOwnership(configEntry),
      force,
      `Emitter '${name}'`
    );

    if (options.includeEventFilter === true) {
      const currentFilter = normalizeConfiguredEventFilter(configEntry);
      assertMutable(currentFilter.ownership, force, `Event filter for emitter '${name}'`);
    }
  }

  function normalizeConfiguredEventFilter(configEntry) {
    const filterSource = configEntry?.eventFilter ?? configEntry;
    const fallbackOwnership = normalizeOwnership(
      configEntry?.eventFilter?.ownership
        ?? configEntry?.eventFilter?.managedBy
        ?? configEntry?.ownership
        ?? configEntry?.managedBy,
      OWNERSHIP.USER_OWNED
    );
    const fallbackLifespan = normalizeLifespan(
      configEntry?.eventFilter?.lifespan
        ?? configEntry?.eventFilter?.scope
        ?? configEntry?.lifespan
        ?? configEntry?.scope,
      LIFESPAN.PERSISTENT
    );

    return EventFilterService.normalize(filterSource, fallbackOwnership, fallbackLifespan);
  }

  function cloneSessionInjector(stream) {
    return stream?.sessionInjector ? { ...stream.sessionInjector } : null;
  }

  function restoreSessionInjector(stream, snapshot) {
    if (stream && snapshot) {
      stream.sessionInjector = { ...snapshot };
    }
  }

  function restoreEmitterEntry(name, previousEmitter) {
    if (previousEmitter) {
      emitters.set(name, previousEmitter);
      return;
    }

    emitters.delete(name);
  }

  function restorePersistentEmitterConfig(name, previousConfigEntry) {
    if (typeof configStore.removeEmitter !== "function" || typeof configStore.upsertEmitter !== "function") {
      return;
    }

    try {
      configStore.removeEmitter(name, true);
      if (previousConfigEntry) {
        configStore.upsertEmitter(previousConfigEntry);
      }
    } catch {
      // Rollback is best-effort; keep the original operation failure as the cause.
    }
  }

  async function stopStartedEmitterForRollback(emitter, originalError) {
    if (typeof lifecycle.stopAndWait === "function") {
      try {
        const result = await lifecycle.stopAndWait(emitter, { timeoutMs: ROLLBACK_STOP_WAIT_TIMEOUT_MS });
        if (result?.timedOut === true) {
          void sessionPort.log(
            `Timed out rolling back emitter '${emitter.name}' after start failure; leaving runtime emitter tracked for manual cleanup.`,
            {
              level: "warning",
              originalError: originalError?.message
            }
          );
          return { stopped: false, timedOut: true };
        }
        return { stopped: true };
      } catch {
        // Fall back to the ordinary stop path below; rollback remains best-effort.
      }
    }

    try {
      await lifecycle.stop(emitter);
      return { stopped: true };
    } catch (stopError) {
      void sessionPort.log(
        `Failed to roll back emitter '${emitter.name}' after start failure: ${stopError.message}`,
        {
          level: "warning",
          originalError: originalError?.message
        }
      );
      return { stopped: false, error: stopError };
    }
  }

  function wrapStartError(emitter, error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new LifecycleError(`Failed to start emitter '${emitter.name}': ${error.message}`, {
      cause: error,
      context: { emitter: emitter.name },
      retryable: true
    });
  }

  function preconfigureSessionInjector(emitter, emitterSpec, stream) {
    const previousSessionInjector = cloneSessionInjector(stream);
    try {
      const subscribedStream = streams.configureSessionInjector(emitter.stream, {
        enabled: true,
        delivery: emitterSpec.delivery,
        scope: emitter.lifespan,
        managedBy: emitter.ownership,
        description: emitter.description,
        force: emitterSpec.force
      });

      return { subscribedStream, previousSessionInjector };
    } catch (error) {
      restoreSessionInjector(stream, previousSessionInjector);
      if (error instanceof AppError) {
        throw error;
      }
      throw new LifecycleError(`Failed to configure session injector for emitter '${emitter.name}': ${error.message}`, {
        cause: error,
        context: { emitter: emitter.name, stream: emitter.stream },
        retryable: false
      });
    }
  }

  function buildStartContext(spec, options) {
    const workspace = emitterWorkspace.createEmitterWorkspace({ baseCwd: options.baseCwd });
    const shouldPersistConfig = options.persistConfig !== false;
    const normalizedSpec = spec?.__emitterSpec === true ? spec : normalizeEmitterSpec(spec);
    const emitterSpec = {
      ...normalizedSpec,
      scope: options.lifespan ?? options.scope ?? normalizedSpec.scope,
      managedBy: options.ownership ?? options.managedBy ?? normalizedSpec.managedBy,
      subscribe: options.subscribe ?? normalizedSpec.subscribe,
      delivery: options.delivery ?? normalizedSpec.delivery,
      force: options.force ?? normalizedSpec.force
    };
    const emitter = buildEmitterState(emitterSpec, workspace.baseCwd, {
      resolveEmitterCwd: workspace.resolveEmitterCwd
    });
    const existing = emitters.get(emitter.name);
    const previousConfigEntry = cloneConfigEntry(configStore.findEmitter?.(emitter.name));

    return {
      shouldPersistConfig,
      emitterSpec,
      emitter,
      existing,
      previousConfigEntry
    };
  }

  function assertStartAllowed({ emitter, emitterSpec, existing, previousConfigEntry }) {
    if (existing && !isTerminalEmitterStatus(existing.status)) {
      throw new ConflictError(`Emitter '${emitter.name}' is already active.`);
    }
    if (existing) {
      assertMutable(existing.ownership, emitterSpec.force, `Emitter '${emitter.name}'`);
    }
    if (emitter.lifespan === LIFESPAN.PERSISTENT) {
      assertPersistentConfigEmitterMutable(emitter.name, previousConfigEntry, emitterSpec.force, {
        includeEventFilter: true
      });
    }
  }

  function prepareStartSubscription({ emitter, emitterSpec, shouldPersistConfig }, options) {
    const stream = streams.ensure(emitter.stream, emitter.description || `Events for ${emitter.name}`);
    // Bootstrap uses this runtime-only option to respect an existing stream
    // injector without persisting that internal decision as subscribe:false.
    const preserveExistingSessionInjector = options.preserveExistingSessionInjector === true;
    const subscribeSetup = emitterSpec.subscribe === true && !preserveExistingSessionInjector
      ? preconfigureSessionInjector(emitter, emitterSpec, stream)
      : null;
    const previousStreamConfigEntry = subscribeSetup
      && shouldPersistConfig
      ? snapshotPersistentStreamConfig(configStore, emitter.stream, { requireConfigStore: true })
      : null;

    return {
      stream,
      subscribeSetup,
      previousStreamConfigEntry
    };
  }

  function applyStartSideEffects({ emitter, subscribeSetup, shouldPersistConfig }) {
    if (subscribeSetup) {
      void sessionPort.log(formatSessionInjectorPolicyLog(subscribeSetup.subscribedStream));
      if (shouldPersistConfig && subscribeSetup.subscribedStream.sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
        configStore.upsertStream(subscribeSetup.subscribedStream);
      }
    }

    if (shouldPersistConfig && emitter.lifespan === LIFESPAN.PERSISTENT) {
      configStore.upsertEmitter(emitter);
      persist();
    } else if (shouldPersistConfig && subscribeSetup?.subscribedStream.sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
      persist();
    }
  }

  async function rollbackStartFailure({
    emitter,
    existing,
    stream,
    subscribeSetup,
    shouldPersistConfig,
    previousStreamConfigEntry,
    previousConfigEntry
  }, lifecycleStarted, error) {
    let rollbackStopped = true;
    if (lifecycleStarted) {
      const rollback = await stopStartedEmitterForRollback(emitter, error);
      rollbackStopped = rollback?.stopped !== false;
    }
    if (rollbackStopped) {
      restoreEmitterEntry(emitter.name, existing);
      restoreSessionInjector(stream, subscribeSetup?.previousSessionInjector);
    }
    if (shouldPersistConfig) {
      restorePersistentStreamConfig(configStore, previousStreamConfigEntry, { requireConfigStore: true });
      restorePersistentEmitterConfig(emitter.name, previousConfigEntry);
    }
    wrapStartError(emitter, error);
  }

  async function runStartTransaction(context) {
    let lifecycleStarted = false;
    try {
      lifecycle.start(context.emitter);
      lifecycleStarted = true;
      applyStartSideEffects(context);
    } catch (error) {
      await rollbackStartFailure(context, lifecycleStarted, error);
    }
  }

  async function logStartedEmitter(emitter) {
    await sessionPort.log(
      `Started emitter '${emitter.name}' (${emitter.emitterType}, ${emitter.runSchedule}) on stream '${emitter.stream}' in ${emitter.cwd}.`
    );
  }

  async function start(spec, options = {}) {
    const startContext = buildStartContext(spec, options);
    assertStartAllowed(startContext);
    const subscriptionContext = prepareStartSubscription(startContext, options);
    const context = { ...startContext, ...subscriptionContext };

    emitters.set(context.emitter.name, context.emitter);
    await runStartTransaction(context);
    await logStartedEmitter(context.emitter);

    const { emitter } = context;
    return emitter;
  }

  async function stop(name, options = {}) {
    const normalized = normalizeName(name);
    const lifespan = normalizeLifespan(options.lifespan ?? options.scope, LIFESPAN.TEMPORARY);
    const emitter = emitters.get(normalized);
    const configEntry = lifespan === LIFESPAN.PERSISTENT && typeof configStore.findEmitter === "function"
      ? configStore.findEmitter(normalized)
      : null;
    const previousConfigEntry = cloneConfigEntry(configEntry);

    if (lifespan === LIFESPAN.PERSISTENT) {
      assertPersistentConfigEmitterMutable(normalized, previousConfigEntry, options.force);
    }

    if (emitter) {
      assertMutable(emitter.ownership, options.force, `Emitter '${normalized}'`);
      await lifecycle.stop(emitter);
    }

    if (lifespan === LIFESPAN.PERSISTENT) {
      let removed = false;
      try {
        removed = configStore.removeEmitter(normalized, options.force);
        if (removed) {
          persist();
          void sessionPort.log(`Removed persistent emitter '${normalized}' from config.`);
        }
      } catch (error) {
        restorePersistentEmitterConfig(normalized, previousConfigEntry);
        throw error;
      }
      if (removed) {
        return {
          name: normalized,
          status: EMITTER_OPERATION_STATUS.REMOVED_FROM_CONFIG
        };
      }

      if (!emitter && !removed) {
        throw new NotFoundError(`Emitter '${normalized}' was not found in the session or persistent config.`);
      }

      return {
        name: normalized,
        status: emitter?.status ?? EMITTER_STATUS.STOPPED
      };
    }

    if (!emitter) {
      throw new NotFoundError(`Emitter '${normalized}' is not running in this session.`);
    }

    return emitter;
  }

  function updateEventFilter(name, input, options = {}) {
    const normalized = normalizeName(name);
    const requestedLifespan = hasExplicitPolicyValue(options.lifespan ?? options.scope)
      ? normalizeLifespan(options.lifespan ?? options.scope, LIFESPAN.TEMPORARY)
      : null;
    const changes = eventFilterUpdateInput(input, options);
    const emitter = emitters.get(normalized);
    const configEntry = configStore.findEmitter(normalized);

    if (emitter) {
      assertMutable(emitter.eventFilter.ownership, options.force, `Event filter for emitter '${normalized}'`);
      const previousEventFilter = emitter.eventFilter;
      const previousLifespan = emitter.lifespan;
      const previousConfigEntry = cloneConfigEntry(configEntry);

      try {
        const nextEventFilter = EventFilterService.update(emitter.eventFilter, changes);
        if (requestedLifespan === LIFESPAN.PERSISTENT || nextEventFilter.lifespan === LIFESPAN.PERSISTENT) {
          assertPersistentConfigEmitterMutable(normalized, previousConfigEntry, options.force, {
            includeEventFilter: true
          });
        }

        emitter.eventFilter = nextEventFilter;

        if (requestedLifespan === LIFESPAN.PERSISTENT) {
          emitter.lifespan = LIFESPAN.PERSISTENT;
        }

        if (emitter.eventFilter.lifespan === LIFESPAN.PERSISTENT) {
          configStore.upsertEmitter(emitter);
          persist();
        }
      } catch (error) {
        emitter.eventFilter = previousEventFilter;
        emitter.lifespan = previousLifespan;
        restorePersistentEmitterConfig(normalized, previousConfigEntry);
        throw error;
      }

      void sessionPort.log(`Updated event filter for emitter '${normalized}': ${formatEventFilter(emitter.eventFilter)}`);

      return emitter;
    }

    if (!configEntry) {
      throw new NotFoundError(`Emitter '${normalized}' is not running, so only a persistent event filter update is possible when it exists in config.`);
    }

    const currentFilter = normalizeConfiguredEventFilter(configEntry);
    const targetLifespan = requestedLifespan ?? currentFilter.lifespan;
    if (targetLifespan !== LIFESPAN.PERSISTENT) {
      throw new NotFoundError(`Emitter '${normalized}' is not running, so only a persistent event filter update is possible when it exists in config.`);
    }

    assertPersistentConfigEmitterMutable(normalized, configEntry, options.force, {
      includeEventFilter: true
    });

    const previousConfigEntry = cloneConfigEntry(configEntry);
    try {
      configEntry.eventFilter = EventFilterService.update(currentFilter, changes);
      persist();
    } catch (error) {
      restorePersistentEmitterConfig(normalized, previousConfigEntry);
      throw error;
    }

    void sessionPort.log(`Updated persistent event filter for emitter '${normalized}': ${formatEventFilter(configEntry.eventFilter)}`);
    return {
      name: normalized,
      status: EMITTER_OPERATION_STATUS.CONFIGURED,
      eventFilter: configEntry.eventFilter
    };
  }

  async function stopAll() {
    const active = [...emitters.values()].filter((emitter) => !isTerminalEmitterStatus(emitter.status));
    await Promise.allSettled(active.map((emitter) => lifecycle.stop(emitter)));
  }

  function normalizeStopWaitOutcome(emitter, result) {
    const timedOut = result?.timedOut === true;
    return {
      name: result?.name ?? emitter.name,
      status: result?.status ?? emitter.status,
      timedOut,
      outcome: result?.outcome ?? (timedOut ? "timedOut" : "stopped")
    };
  }

  function formatStopError(error) {
    return error?.message ?? String(error ?? "unknown error");
  }

  async function stopAllAndWait(options = {}) {
    const active = [...emitters.values()].filter((emitter) => !isTerminalEmitterStatus(emitter.status));
    return await Promise.all(active.map(async (emitter) => {
      try {
        if (typeof lifecycle.stopAndWait === "function") {
          const result = await lifecycle.stopAndWait(emitter, options);
          return normalizeStopWaitOutcome(emitter, result);
        }
        await lifecycle.stop(emitter);
        return normalizeStopWaitOutcome(emitter, { name: emitter.name, status: emitter.status, timedOut: false });
      } catch (error) {
        const message = formatStopError(error);
        void sessionPort.log(`Failed to stop emitter '${emitter.name}' during shutdown: ${message}`, {
          level: "warning"
        });
        return {
          name: emitter.name,
          status: emitter.status,
          timedOut: false,
          outcome: "failed",
          error: message
        };
      }
    }));
  }

  function list() {
    return [...emitters.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function onSessionIdle() {
    for (const emitter of emitters.values()) {
      lifecycle.onSessionIdle(emitter);
    }
  }

  function onSessionActivity() {
    for (const emitter of emitters.values()) {
      lifecycle.onSessionActivity(emitter);
    }
  }

  function has(name) {
    return emitters.has(normalizeName(name));
  }

  function get(name) {
    return emitters.get(normalizeName(name));
  }

  return {
    start,
    stop,
    stopAll,
    stopAllAndWait,
    updateEventFilter,
    list,
    has,
    get,
    onSessionIdle,
    onSessionActivity
  };
}
