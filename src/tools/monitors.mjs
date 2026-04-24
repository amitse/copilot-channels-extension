import { DELIVERY, MANAGED_BY, SCOPE } from "../consts.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { formatClassifier } from "../format/classifier.mjs";
import { formatConfiguredMonitor, formatRunningMonitor } from "../format/monitor.mjs";

function renderMonitorList(channels, configStore, supervisor) {
  const running = supervisor.list();
  const configured = configStore
    .getMonitors()
    .filter((entry) => !supervisor.has(entry.name))
    .sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name)));

  if (running.length === 0 && configured.length === 0) {
    return "No monitors have been defined for this session.";
  }

  return [
    `Session monitors (${running.length}):`,
    ...(running.length > 0
      ? running.map((monitor) => formatRunningMonitor(monitor, channels.ensure(monitor.channel)))
      : ["- <none>"]),
    "",
    `Persistent monitor definitions (${configured.length}):`,
    ...(configured.length > 0 ? configured.map((entry) => formatConfiguredMonitor(entry)) : ["- <none>"])
  ].join("\n");
}

export function createMonitorTools({ channels, configStore, supervisor, getBaseCwd }) {
  return [
    {
      name: "copilot_channels_list_monitors",
      description: "Lists session monitors, loops, one-shot work items, and persistent definitions.",
      handler: async () => renderMonitorList(channels, configStore, supervisor)
    },
    {
      name: "copilot_channels_start_monitor",
      description: "Starts a continuous monitor, looped work item, or one-shot prompt task with classifier rules and optional channel subscription.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique monitor name." },
          command: { type: "string", description: "Shell command to run. Optional when prompt is provided." },
          prompt: { type: "string", description: "Prompt to send to the agent. Optional when command is provided." },
          description: { type: "string", description: "Short summary." },
          channel: { type: "string", description: "Channel to receive accepted lines." },
          cwd: { type: "string", description: "Optional working directory relative to the session cwd." },
          every: { type: "string", description: "Optional repeat interval like 30s, 5m, 2h, or 1d. When omitted, commands run continuously and prompts run once." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Controller label: 'user' or 'model'." },
          autoStart: { type: "boolean", description: "When persistent, whether the monitor should auto-start next session." },
          includeStderr: { type: "boolean", description: "Whether stderr lines are eligible for notification delivery." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the channel." },
          excludePattern: { type: "string", description: "Matching lines are dropped before they reach the channel." },
          notifyPattern: { type: "string", description: "Matching lines notify subscribed channels when delivery='important'." },
          subscribe: { type: "boolean", description: "Whether to subscribe the channel as part of monitor creation." },
          delivery: { type: "string", description: "Subscription delivery mode: 'important' or 'all'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled monitor or subscription." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const scope = args.scope ?? SCOPE.TEMPORARY;
        const managedBy = args.managedBy ?? MANAGED_BY.MODEL;
        const monitor = await supervisor.start(
          { ...args, scope, managedBy },
          {
            baseCwd: getBaseCwd(),
            scope,
            managedBy,
            subscribe: args.subscribe !== false,
            delivery: args.delivery ?? DELIVERY.IMPORTANT,
            force: args.force === true
          }
        );

        return [
          `Started monitor '${monitor.name}'.`,
          `scope=${monitor.scope}`,
          `managedBy=${monitor.managedBy}`,
          `workType=${monitor.workType}`,
          `execution=${monitor.executionMode}`,
          monitor.every ? `every=${monitor.every}` : null,
          `channel=${monitor.channel}`,
          `subscription=${channels.ensure(monitor.channel).subscription.enabled ? "on" : "off"}`,
          `classifier=${formatClassifier(monitor.classifier)}`
        ]
          .filter(Boolean)
          .join("\n");
      }
    },
    {
      name: "copilot_channels_set_classifier",
      description: "Updates what a monitor admits into its channel and what qualifies for subscribed notifications.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Monitor name." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the stream." },
          excludePattern: { type: "string", description: "Matching lines are removed from the stream." },
          notifyPattern: { type: "string", description: "Matching lines notify the subscribed channel when delivery='important'." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          managedBy: { type: "string", description: "Controller label: 'user' or 'model'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled classifier." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = supervisor.updateClassifier(args.name, args, {
          scope: args.scope ?? SCOPE.TEMPORARY,
          managedBy: args.managedBy ?? MANAGED_BY.MODEL,
          force: args.force === true
        });

        const classifier = result.classifier ?? supervisor.get(args.name)?.classifier;
        return `Updated classifier for monitor '${normalizeName(args.name)}': ${formatClassifier(classifier)}`;
      }
    },
    {
      name: "copilot_channels_stop_monitor",
      description: "Stops a running monitor, loop, or one-shot work item. With scope='persistent', it also removes the stored definition from config.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Monitor name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled monitor." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = await supervisor.stop(args.name, {
          scope: args.scope ?? SCOPE.TEMPORARY,
          force: args.force === true
        });

        return `Stop requested for monitor '${normalizeName(args.name)}' (status=${result.status}).`;
      }
    }
  ];
}
