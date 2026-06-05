import { DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION } from "../consts.mjs";
import { applySessionInjectorPolicy } from "../streams/injector-policy.mjs";
import { projectStream } from "../emitter/projection.mjs";
import { NotFoundError, AppError, toAppError } from "../errors/index.mjs";
import { clampLimit } from "../util/text.mjs";
import { normalizeName } from "../util/normalize.mjs";

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
 * Create the application service that owns stream and session-injector operations.
 *
 * @param {{
 *   streams: Object,
 *   configStore: Object,
 *   sessionPort: Object,
 *   persist: Function
 * }} deps
 * @returns {{
 *   listStreams: Function,
 *   postToStream: Function,
 *   getStreamHistory: Function,
 *   setInjectorPolicy: Function,
 *   getStreamState: Function
 * }}
 */
export function createStreamService(deps) {
  const { streams, configStore, sessionPort, persist } = deps;

  /**
   * Return the current stream catalog, ensuring the default stream exists.
   */
  function listStreams() {
    streams.ensure(DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION);
    return streams.list().map((stream) => projectStream(stream));
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
      stream: projectStream(stream),
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
    return { stream: projectStream(stream) };
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
        stream: projectStream(stream),
        state: projectStream(stream)
      };
    } catch (error) {
      rethrowServiceError(error, `Failed to update session injector for stream '${name}'.`, {
        operation: "setInjectorPolicy",
        name
      });
    }
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
    return projectStream(stream);
  }

  return {
    listStreams,
    postToStream,
    getStreamHistory,
    setInjectorPolicy,
    getStreamState
  };
}
