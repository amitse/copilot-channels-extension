import { DEFAULT_STREAM } from "./consts.mjs";
import { createTools } from "./tools/index.mjs";
import { createHooks } from "./hooks.mjs";
import { createProviderGateway } from "./provider/gateway.mjs";
import { createTapRuntimeService } from "./services/tap-runtime-service.mjs";

export function createCopilotChannelsRuntime(options = {}) {
  const runtimeService = createTapRuntimeService({
    cwd: options.cwd,
    session: options.session
  });
  process.stderr.write(`[tap-runtime] init — cwd=${runtimeService.session.getBaseCwd()}\n`);

  const tools = createTools({ tools: runtimeService.tools });
  const hooks = createHooks({ runtime: runtimeService.hooks });

  const tapToolsFn = () => tools;
  const gateway = createProviderGateway({
    tapTools: tapToolsFn,
    getSessionInfo: runtimeService.provider.getSessionInfo,
    log: runtimeService.provider.log
  });
  process.stderr.write(`[tap-runtime] gateway created\n`);

  // When provider tools change, re-register all tools and trigger extension reload
  gateway.onToolsChanged(runtimeService.provider.replaceSessionTools);

  return {
    attachSession: (nextSession) => {
      process.stderr.write(`[tap-runtime] attachSession — id=${nextSession?.id ?? "(none)"}\n`);
      runtimeService.session.attachSession(nextSession);
      if (!gateway.isRunning()) {
        try {
          process.stderr.write(`[tap-runtime] starting gateway…\n`);
          gateway.start();
          process.stderr.write(`[tap-runtime] gateway started\n`);
        } catch (err) {
          process.stderr.write(`[tap-runtime] gateway start failed: ${err?.message ?? err}\n`);
          // Gateway startup must never block session attach
        }
      }
    },
    tools,
    hooks,
    stopAllEmitters: async () => {
      gateway.stop();
      await runtimeService.session.stopAllEmitters();
    },
    appendStreamMessage: runtimeService.session.appendStreamMessage,
    gateway,
    getTools: () => gateway.isRunning() ? gateway.getAllTools(tools) : tools,
    DEFAULT_STREAM
  };
}
