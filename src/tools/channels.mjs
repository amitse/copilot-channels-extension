import { DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION, EVENT_OUTCOME, OWNERSHIP, LIFESPAN, SOURCE } from "../consts.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { clampLimit } from "../util/text.mjs";
import { formatStream, formatStreamHistory } from "../format/stream.mjs";
import { applySessionInjectorPolicy } from "../emitter/injector-policy.mjs";

export function applySessionInjector({ streams, configStore, sessionPort, persist }, rawName, options) {
  return applySessionInjectorPolicy({ streams, configStore, sessionPort, persist }, rawName, options);
}

function renderStreamList(streams) {
  streams.ensure(DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION);
  const values = streams.list();
  return [
    `Streams (${values.length}):`,
    ...values.map((stream) => formatStream(stream))
  ].join("\n");
}

/**
 * @typedef {Object} StreamToolsDeps
 * @property {Object} streams - Event stream manager
 * @property {Object} configStore - Persistent config storage
 * @property {Object} sessionPort - Session logging interface
 * @property {Function} persist - Function to persist config
 */

/**
 * Create stream management tools with capability-specific injection.
 * Different handlers use different subsets of deps:
 * - tap_list_streams / tap_post / tap_stream_history: only need streams + sessionPort
 * - tap_enable/disable_injector: need full deps (streams, sessionPort, configStore, persist)
 * 
 * This is acceptable because the injector operations are stateful and cross-cutting,
 * while the simpler operations are isolated to streams.
 * @param {StreamToolsDeps} deps
 */
export function createStreamTools(deps) {
  const { streams, sessionPort } = deps;
  return [
    {
      name: "tap_list_streams",
      description: "Lists event streams, session injector state, and recent metadata.",
      handler: async () => renderStreamList(streams)
    },
    {
      name: "tap_post",
      description: "Posts a note into a named event stream for later retrieval.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          message: { type: "string", description: "Text to append." },
          source: { type: "string", description: "Optional source label." },
          description: { type: "string", description: "Optional stream description when creating it." }
        },
        required: ["channel", "message"]
      },
      handler: async (args) => {
        const stream = streams.ensure(args.channel, args.description ?? "");
        streams.append(stream.name, {
          source: args.source || SOURCE.TOOL,
          text: args.message
        });
        void sessionPort.log(`Posted message to stream '${stream.name}'.`);
        return `Posted to stream '${stream.name}'.`;
      }
    },
    {
      name: "tap_stream_history",
      description: "Returns recent entries from a named event stream.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name to inspect." },
          limit: { type: "number", description: "How many recent entries to return." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const streamName = normalizeName(args.channel);
        const stream = streams.get(streamName);
        if (!stream) {
          throw new Error(`Stream '${streamName}' does not exist.`);
        }
        return formatStreamHistory(stream, clampLimit(args.limit, 20));
      }
    },
    {
      name: "tap_enable_injector",
      description: "Attaches a session injector to an event stream for this session or persistently.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          description: { type: "string", description: "Optional stream description." },
          delivery: { type: "string", description: "Event outcome mode: 'important' or 'all'." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected session injector." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const stream = applySessionInjector(deps, args.channel, {
          enabled: true,
          delivery: args.delivery ?? EVENT_OUTCOME.SURFACE,
          scope: args.scope ?? LIFESPAN.TEMPORARY,
          managedBy: args.managedBy ?? OWNERSHIP.MODEL_OWNED,
          description: args.description ?? "",
          force: args.force === true
        });

        return `Attached session injector to stream '${stream.name}' with delivery=${stream.sessionInjector.delivery} lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}.`;
      }
    },
    {
      name: "tap_disable_injector",
      description: "Disables the session injector for an event stream.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          managedBy: { type: "string", description: "Ownership label after the update: 'userOwned' or 'modelOwned'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected session injector." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const stream = applySessionInjector(deps, args.channel, {
          enabled: false,
          delivery: args.delivery ?? EVENT_OUTCOME.SURFACE,
          scope: args.scope ?? LIFESPAN.TEMPORARY,
          managedBy: args.managedBy ?? OWNERSHIP.MODEL_OWNED,
          force: args.force === true
        });

        return `Disabled session injector for stream '${stream.name}' with lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}.`;
      }
    }
  ];
}
