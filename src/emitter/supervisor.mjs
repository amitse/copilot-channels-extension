import { EMITTER_OPERATION_STATUS, EMITTER_STATUS, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeName, normalizeLifespan, normalizeOwnership } from "../util/normalize.mjs";
import { assertMutable, isTerminalEmitterStatus } from "../util/policy.mjs";
import { formatEventFilter } from "../format/event-filter.mjs";
import { normalizeEmitterSpec } from "./spec.mjs";
import { buildEmitterState } from "./state.mjs";
import { createLineRouter } from "./line-router.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { applySessionInjectorPolicy } from "../streams/injector-policy.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { ConflictError, LifecycleError, NotFoundError, AppError } from "../errors/index.mjs";

/**
 * @typedef {Object} SupervisorDeps
 * @property {Object} streams - Event stream manager
 * @property {Object} configStore - Persistent config storage
 * @property {Object} notifications - Notification dispatcher for event injection
 * @property {Object} sessionPort - Session logging interface
 * @property {Function} getBaseCwd - Function that returns base working directory
 * @property {Function} persist - Function to persist config
 */

/**
 * Create emitter supervisor with minimal dependency injection.
 * @param {SupervisorDeps} deps
 */
export function createEmitterSupervisor({ streams, configStore, notifications, sessionPort, getBaseCwd, persist }) {
  const emitters = new Map();
  const lineRouter = createLineRouter({ streams, notifications });
  const lifecycle = createLifecycle({ lineRouter, sessionPort });

  async function start(spec, options = {}) {
    const baseCwd = options.baseCwd ?? getBaseCwd();
    const normalizedSpec = spec?.__emitterSpec === true ? spec : normalizeEmitterSpec(spec);
    const emitterSpec = {
      ...normalizedSpec,
      scope: options.scope ?? normalizedSpec.scope,
      managedBy: options.managedBy ?? normalizedSpec.managedBy,
      subscribe: options.subscribe ?? normalizedSpec.subscribe,
      delivery: options.delivery ?? normalizedSpec.delivery,
      force: options.force ?? normalizedSpec.force
    };
    const emitter = buildEmitterState(emitterSpec, baseCwd);
    const existing = emitters.get(emitter.name);

    if (existing && !isTerminalEmitterStatus(existing.status)) {
      throw new ConflictError(`Emitter '${emitter.name}' is already active.`);
    }
    if (existing) {
      assertMutable(existing.ownership, emitterSpec.force, `Emitter '${emitter.name}'`);
    }

    streams.ensure(emitter.stream, emitter.description || `Events for ${emitter.name}`);
    emitters.set(emitter.name, emitter);

    try {
      lifecycle.start(emitter);
    } catch (error) {
      emitters.delete(emitter.name);
      if (error instanceof AppError) {
        throw error;
      }
      throw new LifecycleError(`Failed to start emitter '${emitter.name}': ${error.message}`, {
        cause: error,
        context: { emitter: emitter.name },
        retryable: true
      });
    }

    if (emitterSpec.subscribe === true) {
      applySessionInjectorPolicy(
        { streams, configStore, sessionPort, persist },
        emitter.stream,
        {
          enabled: true,
          delivery: emitterSpec.delivery,
          scope: emitter.lifespan,
          managedBy: emitter.ownership,
          description: emitter.description,
          force: emitterSpec.force
        },
        { persistConfig: false }
      );

    }

    if (emitter.lifespan === LIFESPAN.PERSISTENT) {
      configStore.upsertEmitter(emitter);
      persist();
    } else if (emitterSpec.subscribe === true && streams.ensure(emitter.stream).sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
      persist();
    }

    await sessionPort.log(
      `Started emitter '${emitter.name}' (${emitter.emitterType}, ${emitter.runSchedule}) on stream '${emitter.stream}' in ${emitter.cwd}.`
    );
    return emitter;
  }

  async function stop(name, options = {}) {
    const normalized = normalizeName(name);
    const lifespan = normalizeLifespan(options.scope, LIFESPAN.TEMPORARY);
    const emitter = emitters.get(normalized);

    if (emitter) {
      assertMutable(emitter.ownership, options.force, `Emitter '${normalized}'`);
      await lifecycle.stop(emitter);
    }

    if (lifespan === LIFESPAN.PERSISTENT) {
      const removed = configStore.removeEmitter(normalized, options.force);
      if (removed) {
        persist();
        void sessionPort.log(`Removed persistent emitter '${normalized}' from config.`);
      }

      if (!emitter && !removed) {
        throw new NotFoundError(`Emitter '${normalized}' was not found in the session or persistent config.`);
      }

      return {
        name: normalized,
        status: removed ? EMITTER_OPERATION_STATUS.REMOVED_FROM_CONFIG : emitter?.status ?? EMITTER_STATUS.STOPPED
      };
    }

    if (!emitter) {
      throw new NotFoundError(`Emitter '${normalized}' is not running in this session.`);
    }

    return emitter;
  }

  function updateEventFilter(name, input, options = {}) {
    const normalized = normalizeName(name);
    const lifespan = normalizeLifespan(options.scope, LIFESPAN.TEMPORARY);
    const ownership = normalizeOwnership(options.managedBy, OWNERSHIP.MODEL_OWNED);
    const emitter = emitters.get(normalized);
    const configEntry = configStore.findEmitter(normalized);

    if (emitter) {
      assertMutable(emitter.eventFilter.ownership, options.force, `Event filter for emitter '${normalized}'`);
      emitter.eventFilter = EventFilterService.update(emitter.eventFilter, {
        ...input,
        ownership,
        lifespan
      });

      if (lifespan === LIFESPAN.PERSISTENT) {
        emitter.lifespan = LIFESPAN.PERSISTENT;
        configStore.upsertEmitter(emitter);
        persist();
      }

      void sessionPort.log(`Updated event filter for emitter '${normalized}': ${formatEventFilter(emitter.eventFilter)}`);

      return emitter;
    }

    if (lifespan !== LIFESPAN.PERSISTENT || !configEntry) {
      throw new NotFoundError(`Emitter '${normalized}' is not running, so only a persistent event filter update is possible when it exists in config.`);
    }

    const currentFilter = EventFilterService.normalize(configEntry.eventFilter ?? configEntry);
    assertMutable(currentFilter.ownership ?? normalizeOwnership(configEntry.ownership, OWNERSHIP.USER_OWNED), options.force, `Event filter for emitter '${normalized}'`);

    configEntry.eventFilter = EventFilterService.update(currentFilter, {
      ...input,
      ownership,
      lifespan
    });

    persist();
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
    updateEventFilter,
    list,
    has,
    get,
    onSessionIdle,
    onSessionActivity
  };
}
