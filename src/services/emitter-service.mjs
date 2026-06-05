import { normalizeName } from "../util/normalize.mjs";
import { EmitterSpec } from "../emitter/spec.mjs";
import { projectConfiguredEmitter, projectRunningEmitter } from "../emitter/projection.mjs";
import { AppError, NotFoundError, toAppError } from "../errors/index.mjs";

function rethrowServiceError(error, message, context) {
  if (error instanceof AppError) {
    throw error;
  }

  throw toAppError(error, {
    message,
    context,
    retryable: false
  });
}

/**
 * Create the application service that mediates tool requests and emitter internals.
 *
 * @param {{
 *   streams: Object,
 *   configStore: Object,
 *   supervisor: Object,
 *   getBaseCwd: Function
 * }} deps
 * @returns {{
 *   listEmitters: Function,
 *   startEmitter: Function,
 *   stopEmitter: Function,
 *   updateFilter: Function,
 *   getEmitterState: Function
 * }}
 */
export function createEmitterService(deps) {
  const { streams, configStore, supervisor, getBaseCwd } = deps;

  /**
   * Return a combined view of running and configured emitters.
   * Running emitters are sourced from the supervisor; persistent emitters come from config.
   */
  function listEmitters() {
    const running = supervisor.list().map((emitter) => {
      const stream = streams.get(emitter.stream) ?? streams.ensure(emitter.stream, emitter.description || "");
      return projectRunningEmitter(emitter, stream);
    });
    const configured = configStore
      .getEmitters()
      .filter((entry) => !supervisor.has(entry.name))
      .sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name)))
      .map((entry) => projectConfiguredEmitter(entry, { getStream: (channel) => streams.get(channel) }));

    return { running, configured };
  }

  /**
   * Start an emitter from a canonical or raw spec.
   */
  function startEmitter(spec, options = {}) {
    const canonicalSpec = spec?.__emitterSpec === true ? spec : EmitterSpec.normalize(spec);

    return supervisor
      .start(canonicalSpec, {
        baseCwd: options.baseCwd ?? getBaseCwd()
      })
      .then((emitter) => ({
        emitter,
        state: projectRunningEmitter(emitter, streams.get(emitter.stream) ?? streams.ensure(emitter.stream, emitter.description || ""))
      }))
      .catch((error) => {
        rethrowServiceError(error, `Failed to start emitter '${canonicalSpec.name}'.`, {
          operation: "startEmitter",
          name: canonicalSpec.name
        });
      });
  }

  /**
   * Stop a running emitter and return its latest persisted/runtime state.
   */
  async function stopEmitter(id, options = {}) {
    const name = normalizeName(id);

    try {
      const result = await supervisor.stop(name, options);
      let state = null;
      try {
        state = getEmitterState(name);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
      }
      return { result, state };
    } catch (error) {
      rethrowServiceError(error, `Failed to stop emitter '${name}'.`, {
        operation: "stopEmitter",
        name
      });
    }
  }

  /**
   * Update an emitter's event filter through the supervisor.
   */
  function updateFilter(id, filter, options = {}) {
    const name = normalizeName(id);

    try {
      const result = supervisor.updateEventFilter(name, filter, options);
      return {
        result,
        state: getEmitterState(name)
      };
    } catch (error) {
      rethrowServiceError(error, `Failed to update event filter for emitter '${name}'.`, {
        operation: "updateFilter",
        name
      });
    }
  }

  /**
   * Return the current runtime or persisted state for one emitter.
   */
  function getEmitterState(id) {
    const name = normalizeName(id);
    const running = supervisor.get(name);
    if (running) {
      return projectRunningEmitter(running, streams.get(running.stream) ?? streams.ensure(running.stream, running.description || ""));
    }

    const configured = configStore.findEmitter(name);
    if (configured) {
      return projectConfiguredEmitter(configured, { getStream: (channel) => streams.get(channel) });
    }

    throw new NotFoundError(`Emitter '${name}' was not found in the session or persistent config.`, {
      context: { name }
    });
  }

  return {
    listEmitters,
    startEmitter,
    stopEmitter,
    updateFilter,
    getEmitterState
  };
}
