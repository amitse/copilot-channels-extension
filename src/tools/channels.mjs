import { SOURCE } from "../consts.mjs";
import { normalizeToolError } from "../errors/handler.mjs";
import { formatStream, formatStreamHistory } from "../format/stream.mjs";

function renderStreamList(service) {
  const streams = service.listStreams();

  if (streams.length === 0) {
    return "No event streams have been defined for this session.";
  }

  return [
    `Event streams (${streams.length}):`,
    ...streams.map((stream) => formatStream(stream))
  ].join("\n");
}

function renderInjectorUpdate(action, stream) {
  const injector = stream.sessionInjector;
  return [
    `${action} session injector for stream '${stream.name}'.`,
    `delivery=${injector.delivery}`,
    `lifespan=${injector.lifespan}`,
    `ownership=${injector.ownership}`
  ].join("\n");
}

/**
 * @typedef {Object} StreamToolsDeps
 * @property {Object} streams - Stream and session-injector capabilities
 */

/**
 * Create stream management tools with stream-scoped capabilities.
 * @param {StreamToolsDeps} deps
 */
export function createStreamTools(deps) {
  const runtime = deps.streams ?? deps.runtime;

  return [
    {
      name: "tap_list_streams",
      description: "Lists event streams, session injector state, and recent metadata.",
      handler: async () => {
        try {
          return renderStreamList(runtime);
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_list_streams" }
          });
        }
      }
    },
    {
      name: "tap_post",
      description: "Posts a note into a named event stream for later retrieval.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          message: { type: "string", description: "Text to append." },
          description: { type: "string", description: "Optional stream description when creating it." },
          source: { type: "string", description: "Optional source label." }
        },
        required: ["channel", "message"]
      },
      handler: async (args) => {
        try {
          const { stream } = runtime.postToStream({
            channel: args.channel,
            message: args.message,
            description: args.description,
            source: args.source ?? SOURCE.TOOL
          });

          return `Posted message to stream '${stream.name}'.`;
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_post", channel: args.channel }
          });
        }
      }
    },
    {
      name: "tap_stream_history",
      description: "Returns recent entries from a named event stream.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name to inspect." },
          limit: { type: "integer", description: "How many recent entries to return." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        try {
          const { stream, limit } = runtime.getStreamHistory(args.channel, args.limit);
          return formatStreamHistory(stream, limit);
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_stream_history", channel: args.channel }
          });
        }
      }
    },
    {
      name: "tap_enable_injector",
      description: "Attaches a session injector to an event stream for this session or persistently.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          delivery: { type: "string", description: "Event outcome mode: 'important' or 'all'." },
          description: { type: "string", description: "Optional stream description." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected session injector." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        try {
          const { state } = runtime.setInjectorPolicy(args.channel, {
            enabled: true,
            delivery: args.delivery,
            description: args.description,
            scope: args.scope,
            managedBy: args.managedBy,
            force: args.force === true
          });

          return renderInjectorUpdate("Enabled", state);
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_enable_injector", channel: args.channel }
          });
        }
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
        try {
          const { state } = runtime.setInjectorPolicy(args.channel, {
            enabled: false,
            scope: args.scope,
            managedBy: args.managedBy,
            force: args.force === true
          });

          return renderInjectorUpdate("Disabled", state);
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_disable_injector", channel: args.channel }
          });
        }
      }
    }
  ];
}