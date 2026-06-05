import { SOURCE } from "../consts.mjs";
import { formatSessionInjectorUpdate, formatStream, formatStreamHistory } from "../format/stream.mjs";
import { policyOptions, policyParameterProperties } from "./policy-options.mjs";
import { wrapToolHandler } from "./tool-handler.mjs";

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
      handler: wrapToolHandler("tap_list_streams", {}, async () => renderStreamList(runtime))
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
      handler: wrapToolHandler("tap_post", (args) => ({ channel: args.channel }), async (args) => {
        const { stream } = runtime.postToStream({
          channel: args.channel,
          message: args.message,
          description: args.description,
          source: args.source ?? SOURCE.TOOL
        });

        return `Posted message to stream '${stream.name}'.`;
      })
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
      handler: wrapToolHandler("tap_stream_history", (args) => ({ channel: args.channel }), async (args) => {
        const { stream, limit } = runtime.getStreamHistory(args.channel, args.limit);
        return formatStreamHistory(stream, limit);
      })
    },
    {
      name: "tap_enable_injector",
      description: "Attaches a session injector to an event stream for this session or persistently.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          delivery: { type: "string", description: "Session injector delivery mode. 'important'/'inject' only send inject-outcome events, 'surface' surfaces surface outcomes and sends inject outcomes, 'all' surfaces all accepted events while inject outcomes still push into the conversation, and 'keep'/'drop' store without proactive delivery." },
          description: { type: "string", description: "Optional stream description." },
          ...policyParameterProperties({ force: "sessionInjector" })
        },
        required: ["channel"]
      },
      handler: wrapToolHandler("tap_enable_injector", (args) => ({ channel: args.channel }), async (args) => {
        const { state } = runtime.setInjectorPolicy(args.channel, {
          enabled: true,
          delivery: args.delivery,
          description: args.description,
          ...policyOptions(args)
        });

        return formatSessionInjectorUpdate("Enabled", state);
      })
    },
    {
      name: "tap_disable_injector",
      description: "Disables the session injector for an event stream.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "EventStream name." },
          ...policyParameterProperties({
            scope: "simple",
            managedBy: "afterUpdate",
            force: "sessionInjector"
          })
        },
        required: ["channel"]
      },
      handler: wrapToolHandler("tap_disable_injector", (args) => ({ channel: args.channel }), async (args) => {
        const { state } = runtime.setInjectorPolicy(args.channel, {
          enabled: false,
          ...policyOptions(args)
        });

        return formatSessionInjectorUpdate("Disabled", state);
      })
    }
  ];
}