import { formatEventFilter } from "../format/event-filter.mjs";
import { formatConfiguredEmitter, formatRunningEmitter } from "../format/emitter.mjs";
import { normalizeToolError } from "../errors/handler.mjs";
import { EVENT_FILTER_PARAMETER_SCHEMA } from "./event-filter-schema.mjs";
import {
  policyForceParameter,
  policyManagedByParameter,
  policyOptions,
  policyParameterProperties,
  policyScopeParameter
} from "./policy-options.mjs";

/**
 * Helper: render the full emitter list from canonical service snapshots.
 */
function renderEmitterList(service) {
  const { running, configured } = service.listEmitters();

  if (running.length === 0 && configured.length === 0) {
    return "No emitters have been defined for this session.";
  }

  return [
    `Session emitters (${running.length}):`,
    ...(running.length > 0 ? running.map((emitter) => formatRunningEmitter(emitter, emitter.sessionInjector ? { sessionInjector: emitter.sessionInjector } : null)) : ["- <none>"]),
    "",
    `Persistent emitter definitions (${configured.length}):`,
    ...(configured.length > 0 ? configured.map((entry) => formatConfiguredEmitter(entry)) : ["- <none>"])
  ].join("\n");
}

/**
 * @typedef {Object} EmitterToolsDeps
 * @property {Object} emitters - Emitter management capabilities
 */

/**
 * Create emitter management tools with capability-specific injection.
 * @param {EmitterToolsDeps} deps
 */
export function createEmitterTools(deps) {
  const runtime = deps.emitters ?? deps.runtime;
  return [
    {
      name: "tap_list_emitters",
      description: "Lists session event emitters, their run schedules, and persistent definitions.",
      handler: async () => {
        try {
          return renderEmitterList(runtime);
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_list_emitters" }
          });
        }
      }
    },
    {
      name: "tap_start_emitter",
      description: "Starts a command emitter or prompt emitter. Use 'command' for shell commands whose stdout needs filtering (CommandEmitter). Use 'prompt' for agent-driven tasks (PromptEmitter) — always injects, no filter needed. Prefer prompt for simple repeated messages or agent actions; prefer command for log tailing, process monitoring, or noisy output that needs filtering.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique emitter name." },
          command: { type: "string", description: "Shell command to run (creates a CommandEmitter). Output goes through EventFilter rules to determine whether lines are kept, surfaced, or injected. Use for log tailing, process monitoring, or any external command with stdout." },
          prompt: { type: "string", description: "Prompt to send to the agent (creates a PromptEmitter). Always injects — bypasses EventFilter entirely. Use for repeated agent tasks, status checks, or simple messages." },
          description: { type: "string", description: "Short summary." },
          channel: { type: "string", description: "EventStream to receive accepted events." },
          cwd: { type: "string", description: "Optional working directory relative to the session cwd." },
          every: { type: "string", description: "Optional repeat interval like 30s, 5m, 2h, or 1d. Use 'idle' for prompts that re-run whenever the session is idle. When omitted, commands run continuously and prompts run once." },
          everySchedule: { type: "array", minItems: 1, items: { type: "string" }, description: "Optional backoff schedule — an ordered non-empty list of interval strings (e.g. ['10s','20s','30s','1m','2m','5m','10m']). The emitter uses each interval in sequence, then repeats the last one forever. Overrides 'every' when provided. Cannot be 'idle' entries." },
          scope: policyScopeParameter(),
          managedBy: policyManagedByParameter(),
          autoStart: { type: "boolean", description: "When persistent, whether the emitter should auto-start next session." },
          includeStderr: { type: "boolean", description: "Whether stderr lines are eligible for event outcome evaluation." },
          eventFilter: EVENT_FILTER_PARAMETER_SCHEMA,
          subscribe: { type: "boolean", description: "Whether to attach a session injector to the stream as part of emitter creation." },
          delivery: { type: "string", description: "Session injector delivery ceiling: 'important' (only important lines inject) or 'all' (all lines eligible). Delivery opens the door; EventFilter rules decide which lines walk through it." },
          maxRuns: { type: "integer", description: "Maximum number of iterations before the emitter auto-completes. Useful for idle and timed loops." },
          force: policyForceParameter("emitter")
        },
        required: ["name"]
      },
      handler: async (args) => {
        try {
          const { state } = await runtime.startEmitter(args);

          return [
            `Started emitter '${state.name}'.`,
            `lifespan=${state.scope}`,
            `ownership=${state.ownership}`,
            `emitterType=${state.emitterType}`,
            `runSchedule=${state.runSchedule}`,
            state.everySchedule ? `everySchedule=[${state.everySchedule.join(", ")}]` : null,
            state.every ? `every=${state.every}` : null,
            state.maxRuns ? `maxRuns=${state.maxRuns}` : null,
            `stream=${state.stream}`,
            `sessionInjector=${state.sessionInjector?.enabled ? "on" : "off"}`,
            `eventFilter=${formatEventFilter(state.eventFilter)}`
          ]
            .filter(Boolean)
            .join("\n");
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_start_emitter", name: args.name }
          });
        }
      }
    },
    {
      name: "tap_set_event_filter",
      description: "Updates the canonical event filter rules that determine event outcomes (drop, keep, surface, inject) for an emitter.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          eventFilter: EVENT_FILTER_PARAMETER_SCHEMA,
          ...policyParameterProperties({ force: "emitter" })
        },
        required: ["name"]
      },
      handler: async (args) => {
        try {
          const { state } = runtime.updateFilter(args.name, args.eventFilter ?? {}, policyOptions(args));

          return `Updated event filter for emitter '${state.name}': ${formatEventFilter(state.eventFilter)}`;
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_set_event_filter", name: args.name }
          });
        }
      }
    },
    {
      name: "tap_stop_emitter",
      description: "Stops a running event emitter. With lifespan='persistent', also removes the stored definition from config.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          scope: policyScopeParameter("simple"),
          force: policyForceParameter("emitter")
        },
        required: ["name"]
      },
      handler: async (args) => {
        try {
          const { result, state } = await runtime.stopEmitter(args.name, policyOptions(args, { managedBy: false }));

          return `Stop requested for emitter '${state?.name ?? args.name}' (status=${result.status}).`;
        } catch (error) {
          throw normalizeToolError(error, {
            context: { tool: "tap_stop_emitter", name: args.name }
          });
        }
      }
    }
  ];
}
