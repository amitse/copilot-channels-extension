import { COPILOT_INSTRUCTIONS_PATH, DEFAULT_CHANNEL, DEFAULT_CHANNEL_DESCRIPTION, MANAGED_BY, SCOPE } from "./consts.mjs";

function subscriptionSummary(channels) {
  const subscribed = channels.list().filter((channel) => channel.subscription.enabled);

  if (subscribed.length === 0) {
    return "";
  }

  return [
    "Subscribed channels:",
    ...subscribed.map(
      (channel) =>
        `- ${channel.name} delivery=${channel.subscription.delivery} scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}`
    )
  ].join("\n");
}

async function applyPersistentConfig({ baseCwd, channels, configStore, supervisor, sessionPort, setBaseCwd }) {
  setBaseCwd(baseCwd);
  const configLoad = configStore.load(baseCwd);

  for (const entry of configStore.getChannels()) {
    channels.applyPersistentChannel(entry);
  }

  let started = 0;
  for (const entry of configStore.getMonitors()) {
    if (entry.autoStart === false) {
      continue;
    }

    try {
      await supervisor.start(
        {
          ...entry,
          scope: SCOPE.PERSISTENT,
          managedBy: entry.managedBy ?? MANAGED_BY.USER
        },
        {
          baseCwd,
          scope: SCOPE.PERSISTENT,
          managedBy: entry.managedBy ?? MANAGED_BY.USER,
          subscribe: false,
          force: true
        }
      );
      started += 1;
    } catch (error) {
      await sessionPort.log(`Failed to auto-start monitor '${entry.name}': ${error.message}`, {
        level: "warning"
      });
    }
  }

  return configLoad.found
    ? `Loaded ${configStore.getChannels().length} channels and ${configStore.getMonitors().length} persistent monitor definitions from ${configLoad.filePath}. Auto-started ${started}.`
    : "No copilot-channels config file found.";
}

export function createHooks({ channels, configStore, supervisor, sessionPort, setBaseCwd }) {
  return {
    onSessionStart: async (input) => {
      channels.ensure(DEFAULT_CHANNEL, DEFAULT_CHANNEL_DESCRIPTION);

      let configSummary = "No config loaded.";
      try {
        configSummary = await applyPersistentConfig({
          baseCwd: input.cwd,
          channels,
          configStore,
          supervisor,
          sessionPort,
          setBaseCwd
        });
        await sessionPort.log(configSummary);
      } catch (error) {
        configSummary = `Config load failed: ${error.message}`;
        await sessionPort.log(configSummary, { level: "warning" });
      }

      return {
        additionalContext: [
          "copilot-channels-extension is active.",
          "Use channel subscriptions when you want ongoing attention on a stream; use monitors to collect background output; use prompt-based work items and loops when the right action is to re-run a prompt or command over time; use classifiers to decide what reaches the stream and what triggers delivery.",
          "Subscribed channel updates are sent immediately from monitor output and do not wait for transcript events.",
          `Repo guidance is available at ${COPILOT_INSTRUCTIONS_PATH} if you want to read the project-specific instructions.`,
          configSummary,
          subscriptionSummary(channels)
        ]
          .filter(Boolean)
          .join("\n")
      };
    },

    onUserPromptSubmitted: async () => {
      const summary = subscriptionSummary(channels);
      if (!summary) {
        return undefined;
      }
      return { additionalContext: summary };
    },

    onSessionEnd: async () => {
      await supervisor.stopAll();
      return {
        sessionSummary: `copilot-channels-extension tracked ${channels.size()} channels and ${configStore.getMonitors().length} persistent monitor definitions.`,
        cleanupActions: ["Stopped session monitors managed by copilot-channels-extension."]
      };
    }
  };
}
