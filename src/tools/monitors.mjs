import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { formatEventFilter } from "../format/event-filter.mjs";
import { formatConfiguredEmitter, formatRunningEmitter } from "../format/emitter.mjs";

function renderEmitterList(streams, configStore, supervisor) {
  const running = supervisor.list();
  const configured = configStore
    .getEmitters()
    .filter((entry) => !supervisor.has(entry.name))
    .sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name)));

  if (running.length === 0 && configured.length === 0) {
    return "No emitters have been defined for this session.";
  }

  return [
    `Session emitters (${running.length}):`,
    ...(running.length > 0
      ? running.map((emitter) => formatRunningEmitter(emitter, streams.ensure(emitter.stream)))
      : ["- <none>"]),
    "",
    `Persistent emitter definitions (${configured.length}):`,
    ...(configured.length > 0 ? configured.map((entry) => formatConfiguredEmitter(entry)) : ["- <none>"])
  ].join("\n");
}

export function createEmitterTools({ streams, configStore, supervisor, getBaseCwd }) {
  return [
    {
      name: "tap_list_emitters",
      description: "Lists session event emitters, their run schedules, and persistent definitions.",
      handler: async () => renderEmitterList(streams, configStore, supervisor)
    },
    {
      name: "tap_start_emitter",
      description: "Starts a command emitter or prompt emitter. Use 'command' for shell commands whose stdout needs filtering (CommandEmitter) — requires notifyPattern for injection. Use 'prompt' for agent-driven tasks (PromptEmitter) — always injects, no filter needed. Prefer prompt for simple repeated messages or agent actions; prefer command for log tailing, process monitoring, or noisy output that needs filtering.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique emitter name." },
          command: { type: "string", description: "Shell command to run (creates a CommandEmitter). Output goes through EventFilter — requires notifyPattern to inject lines into the session. Use for log tailing, process monitoring, or any external command with stdout." },
          prompt: { type: "string", description: "Prompt to send to the agent (creates a PromptEmitter). Always injects — bypasses EventFilter entirely, no notifyPattern needed. Use for repeated agent tasks, status checks, or simple messages." },
          description: { type: "string", description: "Short summary." },
          channel: { type: "string", description: "EventStream to receive accepted events." },
          cwd: { type: "string", description: "Optional working directory relative to the session cwd." },
          every: { type: "string", description: "Optional repeat interval like 30s, 5m, 2h, or 1d. Use 'idle' for prompts that re-run whenever the session is idle. When omitted, commands run continuously and prompts run once." },
          everySchedule: { type: "array", minItems: 1, items: { type: "string" }, description: "Optional backoff schedule — an ordered non-empty list of interval strings (e.g. ['10s','20s','30s','1m','2m','5m','10m']). The emitter uses each interval in sequence, then repeats the last one forever. Overrides 'every' when provided. Cannot be 'idle' entries." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          autoStart: { type: "boolean", description: "When persistent, whether the emitter should auto-start next session." },
          includeStderr: { type: "boolean", description: "Whether stderr lines are eligible for event outcome evaluation." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the stream. (Legacy: prefer eventFilter rules.)" },
          excludePattern: { type: "string", description: "Matching lines are dropped before they reach the stream. (Legacy: prefer eventFilter rules.)" },
          notifyPattern: { type: "string", description: "Regex pattern — matching lines are injected into the session. Without this, lines are stored/surfaced but never injected. This is the trigger that decides which lines actually interrupt the conversation." },
          subscribe: { type: "boolean", description: "Whether to attach a session injector to the stream as part of emitter creation." },
          delivery: { type: "string", description: "Session injector delivery ceiling: 'important' (only notifyPattern matches inject) or 'all' (all lines eligible). delivery opens the door, notifyPattern decides which lines walk through it. Without notifyPattern, no lines are injected regardless of delivery setting." },
          maxRuns: { type: "integer", description: "Maximum number of iterations before the emitter auto-completes. Useful for idle and timed loops." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected emitter." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const lifespan = args.scope ?? LIFESPAN.TEMPORARY;
        const ownership = args.managedBy ?? OWNERSHIP.MODEL_OWNED;
        const emitter = await supervisor.start(
          { ...args, scope: lifespan, managedBy: ownership },
          {
            baseCwd: getBaseCwd(),
            scope: lifespan,
            managedBy: ownership,
            subscribe: args.subscribe !== false,
            delivery: args.delivery ?? EVENT_OUTCOME.SURFACE,
            force: args.force === true
          }
        );

        return [
          `Started emitter '${emitter.name}'.`,
          `lifespan=${emitter.lifespan}`,
          `ownership=${emitter.ownership}`,
          `emitterType=${emitter.emitterType}`,
          `runSchedule=${emitter.runSchedule}`,
          emitter.everySchedule ? `everySchedule=[${emitter.everySchedule.join(", ")}]` : null,
          emitter.every && !emitter.everySchedule ? `every=${emitter.every}` : null,
          emitter.maxRuns ? `maxRuns=${emitter.maxRuns}` : null,
          `stream=${emitter.stream}`,
          `sessionInjector=${streams.ensure(emitter.stream).sessionInjector.enabled ? "on" : "off"}`,
          `eventFilter=${formatEventFilter(emitter.eventFilter)}`
        ]
          .filter(Boolean)
          .join("\n");
      }
    },
    {
      name: "tap_set_event_filter",
      description: "Updates the event filter rules that determine event outcomes (drop, keep, surface, inject) for an emitter.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the stream." },
          excludePattern: { type: "string", description: "Matching lines are removed from the stream." },
          notifyPattern: { type: "string", description: "Matching lines trigger session injection when delivery='important'." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected emitter." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = supervisor.updateEventFilter(args.name, args, {
          scope: args.scope ?? LIFESPAN.TEMPORARY,
          managedBy: args.managedBy ?? OWNERSHIP.MODEL_OWNED,
          force: args.force === true
        });

        const eventFilter = result.eventFilter ?? supervisor.get(args.name)?.eventFilter;
        return `Updated event filter for emitter '${normalizeName(args.name)}': ${formatEventFilter(eventFilter)}`;
      }
    },
    {
      name: "tap_stop_emitter",
      description: "Stops a running event emitter. With lifespan='persistent', also removes the stored definition from config.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected emitter." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = await supervisor.stop(args.name, {
          scope: args.scope ?? LIFESPAN.TEMPORARY,
          force: args.force === true
        });

        return `Stop requested for emitter '${normalizeName(args.name)}' (status=${result.status}).`;
      }
    }
  ];
}
