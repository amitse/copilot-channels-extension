import { DEFAULT_CHANNEL, DEFAULT_CHANNEL_DESCRIPTION, DELIVERY, MANAGED_BY, SCOPE, SOURCE } from "../consts.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { clampLimit } from "../util/text.mjs";
import { formatChannel, formatChannelHistory } from "../format/channel.mjs";

export function applySubscription({ channels, configStore, sessionPort, persist }, rawName, options) {
  const channel = channels.configureSubscription(rawName, options);

  void sessionPort.log(
    `${channel.subscription.enabled ? "Subscribed" : "Unsubscribed"} channel '${channel.name}' with delivery=${channel.subscription.delivery} scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}.`
  );

  if (channel.subscription.scope === SCOPE.PERSISTENT) {
    configStore.upsertChannel(channel);
    persist();
  }

  return channel;
}

function renderChannelList(channels) {
  channels.ensure(DEFAULT_CHANNEL, DEFAULT_CHANNEL_DESCRIPTION);
  const values = channels.list();
  return [
    `Channels (${values.length}):`,
    ...values.map((channel) => formatChannel(channel))
  ].join("\n");
}

export function createChannelTools(deps) {
  const { channels, sessionPort } = deps;
  return [
    {
      name: "copilot_channels_list_channels",
      description: "Lists channels, subscription state, and recent metadata managed by copilot-channels-extension.",
      handler: async () => renderChannelList(channels)
    },
    {
      name: "copilot_channels_post",
      description: "Posts a note into a named channel for later retrieval.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name." },
          message: { type: "string", description: "Text to append." },
          source: { type: "string", description: "Optional source label." },
          description: { type: "string", description: "Optional channel description when creating it." }
        },
        required: ["channel", "message"]
      },
      handler: async (args) => {
        const channel = channels.ensure(args.channel, args.description ?? "");
        channels.append(channel.name, {
          source: args.source || SOURCE.TOOL,
          text: args.message
        });
        void sessionPort.log(`Posted message to channel '${channel.name}'.`);
        return `Posted to channel '${channel.name}'.`;
      }
    },
    {
      name: "copilot_channels_history",
      description: "Returns recent entries from a named channel.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name to inspect." },
          limit: { type: "number", description: "How many recent entries to return." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const channelName = normalizeName(args.channel);
        const channel = channels.get(channelName);
        if (!channel) {
          throw new Error(`Channel '${channelName}' does not exist.`);
        }
        return formatChannelHistory(channel, clampLimit(args.limit, 20));
      }
    },
    {
      name: "copilot_channels_subscribe",
      description: "Subscribes the agent to a channel either for this session only or persistently via config.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name." },
          description: { type: "string", description: "Optional channel description." },
          delivery: { type: "string", description: "Notification mode: 'important' or 'all'." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Controller label: 'user' or 'model'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled subscription." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const channel = applySubscription(deps, args.channel, {
          enabled: true,
          delivery: args.delivery ?? DELIVERY.IMPORTANT,
          scope: args.scope ?? SCOPE.TEMPORARY,
          managedBy: args.managedBy ?? MANAGED_BY.MODEL,
          description: args.description ?? "",
          force: args.force === true
        });

        return `Subscribed to channel '${channel.name}' with delivery=${channel.subscription.delivery} scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}.`;
      }
    },
    {
      name: "copilot_channels_unsubscribe",
      description: "Disables subscription delivery for a channel, temporarily or persistently.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          managedBy: { type: "string", description: "Controller label after the update: 'user' or 'model'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled subscription." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const channel = applySubscription(deps, args.channel, {
          enabled: false,
          delivery: args.delivery ?? DELIVERY.IMPORTANT,
          scope: args.scope ?? SCOPE.TEMPORARY,
          managedBy: args.managedBy ?? MANAGED_BY.MODEL,
          force: args.force === true
        });

        return `Unsubscribed channel '${channel.name}' with scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}.`;
      }
    }
  ];
}
