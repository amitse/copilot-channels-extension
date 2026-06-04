import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN, SOURCE } from "../consts.mjs";
import { formatStream, formatStreamHistory } from "../format/stream.mjs";
import { createEmitterService } from "../services/emitter-service.mjs";
import { normalizeToolError } from "../errors/handler.mjs";

function renderStreamList(values) {
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
 * Handlers now go through the emitter service so tool code stays wiring-only.
 * @param {StreamToolsDeps} deps
 */
export function createStreamTools(deps) {
  const service = createEmitterService(deps);
  return [
    {
      name: "tap_list_streams",
      description: "Lists event streams, session injector state, and recent metadata.",
      handler: async () => {
        try {
          return renderStreamList(service.listStreams());
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
          source: { type: "string", description: "Optional source label." },
          description: { type: "string", description: "Optional stream description when creating it." }
        },
        required: ["channel", "message"]
      },
      handler: async (args) => {
        try {
          const { stream } = service.postToStream({
            channel: args.channel,
            message: args.message,
            source: args.source || SOURCE.TOOL,
            description: args.description
          });
          return `Posted to stream '${stream.name}'.`;
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
          limit: { type: "number", description: "How many recent entries to return." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        try {
          const { stream, limit } = service.getStreamHistory(args.channel, args.limit);
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
          description: { type: "string", description: "Optional stream description." },
          delivery: { type: "string", description: "Event outcome mode: 'important' or 'all'." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected session injector." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        try {
          const { stream } = service.setInjectorPolicy(args.channel, {
            enabled: true,
            delivery: args.delivery ?? EVENT_OUTCOME.SURFACE,
            scope: args.scope ?? LIFESPAN.TEMPORARY,
            managedBy: args.managedBy ?? OWNERSHIP.MODEL_OWNED,
            description: args.description ?? "",
            force: args.force === true
          });

          return `Attached session injector to stream '${stream.name}' with delivery=${stream.sessionInjector.delivery} lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}.`;
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
          const { stream } = service.setInjectorPolicy(args.channel, {
            enabled: false,
            scope: args.scope ?? LIFESPAN.TEMPORARY,
            managedBy: args.managedBy ?? OWNERSHIP.MODEL_OWNED,
            force: args.force === true
          });

          return `Disabled session injector for stream '${stream.name}' with lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}.`;
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_disable_injector", channel: args.channel }
          });
        }
      }
    }
  ];
}
