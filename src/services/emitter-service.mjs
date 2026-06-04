import { DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION } from "../consts.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { clampLimit } from "../util/text.mjs";
import { applySessionInjectorPolicy } from "../emitter/injector-policy.mjs";
import { EmitterSpec } from "../emitter/spec.mjs";
import { projectConfiguredEmitter } from "../emitter/projection.mjs";
import { AppError, NotFoundError, toAppError } from "../errors/index.mjs";

function snapshotRunningEmitter(emitter, stream) {
  return {
    ...emitter,
    eventFilter: emitter.eventFilter
      ? {
          ...emitter.eventFilter,
          rules: Array.isArray(emitter.eventFilter.rules)
            ? emitter.eventFilter.rules.map((rule) => ({ ...rule }))
            : []
        }
      : null,
    channel: emitter.stream,
    ownership: emitter.ownership,
    sessionInjector: stream?.sessionInjector ? { ...stream.sessionInjector } : null,
    source: "running"
  };
}

function snapshotStream(stream) {
  if (!stream) {
    return null;
  }

  return {
    ...stream,
    entries: Array.isArray(stream.entries) ? stream.entries.map((entry) => ({ ...entry })) : [],
    sessionInjector: stream.sessionInjector ? { ...stream.sessionInjector } : null
  };
}

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
 *   sessionPort: Object,
 *   getBaseCwd: Function,
 *   persist: Function
 * }} deps
 * @returns {{
 *   listEmitters: Function,
 *   listStreams: Function,
 *   postToStream: Function,
 *   getStreamHistory: Function,
 *   startEmitter: Function,
 *   stopEmitter: Function,
 *   updateFilter: Function,
 *   setInjectorPolicy: Function,
 *   getEmitterState: Function,
 *   getStreamState: Function
 * }}
 */
export function createEmitterService(deps) {
  const { streams, configStore, supervisor, sessionPort, getBaseCwd, persist } = deps;

  /**
   * Return a combined view of running and configured emitters.
   * Running emitters are sourced from the supervisor; persistent emitters come from config.
   */
  function listEmitters() {
    const running = supervisor.list().map((emitter) => {
      const stream = streams.get(emitter.stream) ?? streams.ensure(emitter.stream, emitter.description || "");
      return snapshotRunningEmitter(emitter, stream);
    });
    const configured = configStore
      .getEmitters()
      .filter((entry) => !supervisor.has(entry.name))
      .sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name)))
      .map((entry) => projectConfiguredEmitter(entry, { getStream: (channel) => streams.get(channel) }));

    return { running, configured };
  }

  /**
   * Return the current stream catalog, ensuring the default stream exists.
   */
  function listStreams() {
    streams.ensure(DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION);
    return streams.list().map((stream) => snapshotStream(stream));
  }

  /**
   * Fetch a stream and clamp the requested history window.
   */
  function getStreamHistory(channel, limit) {
    const name = normalizeName(channel);
    const stream = streams.get(name);
    if (!stream) {
      throw new NotFoundError(`Stream '${name}' does not exist.`, {
        context: { channel: name }
      });
    }

    return {
      stream: snapshotStream(stream),
      limit: clampLimit(limit, 20)
    };
  }

  /**
   * Append a message to a stream and return the updated stream snapshot.
   */
  function postToStream({ channel, message, source, description }) {
    const stream = streams.ensure(channel, description ?? "");
    streams.append(stream.name, {
      source,
      text: message
    });
    void sessionPort.log(`Posted message to stream '${stream.name}'.`);
    return { stream: snapshotStream(stream) };
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
        state: snapshotRunningEmitter(emitter, streams.get(emitter.stream) ?? streams.ensure(emitter.stream, emitter.description || ""))
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
   * Configure the session injector policy for a stream.
   */
  function setInjectorPolicy(id, policy) {
    const name = normalizeName(id);

    try {
      const stream = applySessionInjectorPolicy(
        { streams, configStore, sessionPort, persist },
        name,
        policy,
        { persistConfig: true }
      );

      return {
        stream: snapshotStream(stream),
        state: snapshotStream(stream)
      };
    } catch (error) {
      rethrowServiceError(error, `Failed to update session injector for stream '${name}'.`, {
        operation: "setInjectorPolicy",
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
      return snapshotRunningEmitter(running, streams.get(running.stream) ?? streams.ensure(running.stream, running.description || ""));
    }

    const configured = configStore.findEmitter(name);
    if (configured) {
      return projectConfiguredEmitter(configured, { getStream: (channel) => streams.get(channel) });
    }

    throw new NotFoundError(`Emitter '${name}' was not found in the session or persistent config.`, {
      context: { name }
    });
  }

  /**
   * Return a snapshot of the named stream.
   */
  function getStreamState(id) {
    const name = normalizeName(id, DEFAULT_STREAM);
    const stream = streams.get(name);
    if (!stream) {
      throw new NotFoundError(`Stream '${name}' does not exist.`, {
        context: { channel: name }
      });
    }
    return snapshotStream(stream);
  }

  return {
    listEmitters,
    listStreams,
    postToStream,
    getStreamHistory,
    startEmitter,
    stopEmitter,
    updateFilter,
    setInjectorPolicy,
    getEmitterState,
    getStreamState
  };
}
