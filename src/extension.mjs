import { joinSession } from "@github/copilot-sdk/extension";

import { createCopilotChannelsRuntime } from "./tap-runtime.mjs";

// Reload-safe: cache runtime on globalThis so provider connections,
// emitters, streams, and config survive extensions.reload() cycles.
const runtime = globalThis.__tapRuntime ??= createCopilotChannelsRuntime({
  cwd: process.cwd()
});

const session = await joinSession({
  tools: runtime.getTools(),
  hooks: runtime.hooks
});

runtime.attachSession(session);
runtime.appendStreamMessage(runtime.DEFAULT_STREAM, {
  source: "system",
  text: "※ tap loaded."
});

session.on("session.shutdown", () => {
  // Broadcast shutdown.pending to all connected providers
  if (runtime.gateway?.isRunning()) {
    const sessionId = session.id ?? "default";
    runtime.gateway.broadcastLifecycle(sessionId, "shutdown.pending", 10000);
  }
  void runtime.stopAllEmitters();
});
