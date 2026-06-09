import { joinSession } from "@github/copilot-sdk/extension";

import { createCopilotChannelsRuntime } from "./tap-runtime.mjs";

// Verbose stderr logger — CLI captures stderr; these lines appear in the process log.
function tapLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[tap ${ts}] ${msg}\n`);
}

tapLog(`extension.mjs loading — pid=${process.pid} cwd=${process.cwd()} SESSION_ID=${process.env.SESSION_ID ?? "(none)"} COPILOT_SDK_PATH=${process.env.COPILOT_SDK_PATH ?? "(none)"}`);

// Reload-safe: cache runtime on globalThis so provider connections,
// emitters, streams, and config survive extensions.reload() cycles.
const isResume = Boolean(globalThis.__tapRuntime);
tapLog(`runtime ${isResume ? "resuming (cached)" : "creating (fresh)"}`);
const runtime = globalThis.__tapRuntime ??= createCopilotChannelsRuntime({
  cwd: process.cwd()
});
tapLog("runtime ready");

tapLog("calling joinSession…");
let session;
try {
  session = await joinSession({
    tools: runtime.getTools(),
    hooks: runtime.hooks
  });
  tapLog(`joinSession OK — session.id=${session.id ?? "(none)"}`);
} catch (err) {
  tapLog(`joinSession FAILED: ${err?.message ?? err}`);
  if (err?.stack) tapLog(err.stack.split("\n").slice(1, 4).join(" | "));
  throw err;
}

tapLog("attaching session to runtime…");
runtime.attachSession(session);
tapLog("session attached — tap is live");
runtime.appendStreamMessage(runtime.DEFAULT_STREAM, {
  source: "system",
  text: "※ tap loaded."
});
