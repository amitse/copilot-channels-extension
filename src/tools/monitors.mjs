import { formatEventFilter } from "../format/event-filter.mjs";
import { formatConfiguredEmitter, formatRunningEmitter } from "../format/emitter.mjs";
import { EVENT_FILTER_PARAMETER_SCHEMA } from "./event-filter-schema.mjs";
import {
  policyForceParameter,
  policyLifespanParameter,
  policyManagedByParameter,
  policyOwnershipParameter,
  policyOptions,
  policyParameterProperties,
  policyScopeParameter
} from "./policy-options.mjs";
import { wrapToolHandler } from "./tool-handler.mjs";

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
    ...(configured.length > 0 ? configured.map((emitter) => formatConfiguredEmitter(emitter)) : ["- <none>"])
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
      handler: wrapToolHandler("tap_list_emitters", {}, async () => renderEmitterList(runtime))
    },
    {
      name: "tap_start_emitter",
      description: "Starts a command emitter or prompt emitter. Use 'command' for shell commands whose stdout needs filtering (CommandEmitter). Use 'prompt' for agent-driven tasks (PromptEmitter) — always injects, no filter needed. Prefer prompt for simple repeated messages or agent actions; prefer command for log tailing, process monitoring, or noisy output that needs filtering. Use lifespan/ownership for canonical policy fields; legacy scope/managedBy aliases remain supported.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique emitter name." },
          command: { type: "string", description: "Shell command to run (creates a CommandEmitter). Output goes through EventFilter rules to determine whether lines are kept, surfaced, or injected. Use for log tailing, process monitoring, or any external command with stdout." },
          prompt: { type: "string", description: "Prompt to send to the agent (creates a PromptEmitter). Always injects — bypasses EventFilter entirely. Use for repeated agent tasks, status checks, or simple messages." },
          description: { type: "string", description: "Short summary." },
          channel: { type: "string", description: "EventStream to receive accepted events." },
          cwd: { type: "string", description: "Optional subdirectory relative to the session cwd. Absolute paths and paths that escape the session cwd are rejected." },
          every: { type: "string", description: "Optional repeat interval like 30s, 5m, 2h, or 1d (maximum about 24 days). Use 'idle' for prompts that re-run whenever the session is idle. When omitted, commands run continuously and prompts run once." },
          everySchedule: { type: "array", minItems: 1, items: { type: "string" }, description: "Optional backoff schedule — an ordered non-empty list of interval strings (e.g. ['10s','20s','30s','1m','2m','5m','10m']; each maximum about 24 days). The emitter uses each interval in sequence, then repeats the last one forever. Overrides 'every' when provided. Cannot be 'idle' entries." },
          lifespan: policyLifespanParameter(),
          ownership: policyOwnershipParameter(),
          scope: policyScopeParameter(),
          managedBy: policyManagedByParameter(),
          autoStart: { type: "boolean", description: "When persistent, whether the emitter should auto-start next session." },
          includeStderr: { type: "boolean", description: "Whether stderr lines are eligible for event outcome evaluation." },
          eventFilter: EVENT_FILTER_PARAMETER_SCHEMA,
          subscribe: { type: "boolean", description: "Whether to attach a session injector to the stream as part of emitter creation." },
          delivery: { type: "string", description: "Session injector delivery mode. 'important'/'inject' only send inject-outcome lines, 'surface' surfaces surface outcomes and sends inject outcomes, 'all' surfaces all accepted lines while inject outcomes still push into the conversation, and 'keep'/'drop' store without proactive delivery." },
          maxRuns: { type: "integer", description: "Maximum number of iterations before the emitter auto-completes. Useful for idle and timed loops." },
          force: policyForceParameter("emitter")
        },
        required: ["name"]
      },
      handler: wrapToolHandler("tap_start_emitter", (args) => ({ name: args.name }), async (args) => {
        const { state } = await runtime.startEmitter(args);

        return [
          `Started emitter '${state.name}'.`,
          `lifespan=${state.lifespan ?? state.scope}`,
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
      })
    },
    {
      name: "tap_set_event_filter",
      description: "Updates the canonical event filter rules that determine event outcomes (drop, keep, surface, inject) for an emitter. Use lifespan/ownership for canonical policy fields; legacy scope/managedBy aliases remain supported.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          eventFilter: EVENT_FILTER_PARAMETER_SCHEMA,
          ...policyParameterProperties({ force: "emitter" })
        },
        required: ["name"]
      },
      handler: wrapToolHandler("tap_set_event_filter", (args) => ({ name: args.name }), async (args) => {
        const { state } = runtime.updateFilter(args.name, args.eventFilter ?? {}, policyOptions(args));

        return `Updated event filter for emitter '${state.name}': ${formatEventFilter(state.eventFilter)}`;
      })
    },
    {
      name: "tap_stop_emitter",
      description: "Stops a running event emitter. With lifespan='persistent', also removes the stored definition from config. Legacy scope remains supported as an alias for lifespan.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          lifespan: policyLifespanParameter("simple"),
          scope: policyScopeParameter("simple"),
          force: policyForceParameter("emitter")
        },
        required: ["name"]
      },
      handler: wrapToolHandler("tap_stop_emitter", (args) => ({ name: args.name }), async (args) => {
        const { result, state } = await runtime.stopEmitter(args.name, policyOptions(args, { managedBy: false }));

        return `Stop requested for emitter '${state?.name ?? args.name}' (status=${result.status}).`;
      })
    }
  ];
}
