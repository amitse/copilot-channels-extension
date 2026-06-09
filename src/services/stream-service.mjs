import { DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION } from "../consts.mjs";
import { applySessionInjectorPolicy } from "../streams/injector-policy.mjs";
import { projectStream } from "../streams/projection.mjs";
import { NotFoundError, ValidationError } from "../errors/index.mjs";
import { rethrowServiceError } from "../errors/service-boundary.mjs";
import { clampLimit, toText } from "../util/text.mjs";
import { requireNormalizedName } from "../util/normalize.mjs";

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

  function requireStreamChannel(channel, operation) {
    return requireNormalizedName(channel, {
      label: "Stream channel",
      contextKey: "channel",
      context: { operation }
    });
  }

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
    const name = requireStreamChannel(channel, "getStreamHistory");
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
  function postToStream(input = {}) {
    const { channel, message, source, description } = input ?? {};
    const name = requireStreamChannel(channel, "postToStream");
    const text = toText(message).trim();
    if (!text) {
      throw new ValidationError("Cannot post an empty message to an event stream.", {
        context: { channel: name }
      });
    }

    const stream = streams.ensure(name, description ?? "");
    const appended = streams.append(stream.name, {
      source,
      text
    });
    if (appended === null) {
      throw new ValidationError("Cannot post an empty message to an event stream.", {
        context: { channel: stream.name }
      });
    }

    void sessionPort.log(`Posted message to stream '${stream.name}'.`);
    return { stream: projectStream(stream) };
  }

  /**
   * Configure the session injector policy for a stream.
   */
  function setInjectorPolicy(id, policy) {
    const name = requireStreamChannel(id, "setInjectorPolicy");

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
    const name = requireStreamChannel(id, "getStreamState");
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
