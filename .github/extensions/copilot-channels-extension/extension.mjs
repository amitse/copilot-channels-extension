import { joinSession } from "@github/copilot-sdk/extension";

import { createCopilotChannelsRuntime } from "../../../src/copilot-channels-runtime.mjs";

const runtime = createCopilotChannelsRuntime({
  cwd: process.cwd()
});

const session = await joinSession({
  tools: runtime.tools,
  hooks: runtime.hooks
});

runtime.attachSession(session);
runtime.appendChannelMessage(runtime.DEFAULT_CHANNEL, {
  source: "system",
  text: "copilot-channels-extension loaded."
});

session.on("session.shutdown", () => {
  void runtime.stopAllMonitors();
});
