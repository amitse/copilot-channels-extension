import { BRAND, COPILOT_INSTRUCTIONS_PATH } from "../consts.mjs";
import { formatSessionInjectorContextSummary } from "../format/stream.mjs";
import { checkForUpdate as defaultCheckForUpdate } from "../update/checker.mjs";

export function createRuntimeHooks({
  streams,
  sessionPort,
  loadPersistentConfig,
  stopAllEmitters,
  listStreams,
  listEmitters,
  checkForUpdate = defaultCheckForUpdate
}) {
  function getSessionStartContext(configSummary) {
    return [
      `${BRAND} is active.`,
      "Use event emitters to run background commands or prompts; use event filters to control which events are kept, surfaced, or injected; use session injectors when you want events surfaced or injected into the session.",
      "Session injector updates are sent immediately from emitter output and do not wait for transcript events.",
      `Repo guidance is available at ${COPILOT_INSTRUCTIONS_PATH} if you want to read the project-specific instructions.`,
      configSummary,
      formatSessionInjectorContextSummary(streams.list())
    ]
      .filter(Boolean)
      .join("\n");
  }

  function getPromptContext() {
    const summary = formatSessionInjectorContextSummary(streams.list());
    return summary ? { additionalContext: summary } : undefined;
  }

  const hooks = {
    onSessionStart: async (input = {}) => {
      // Fire-and-forget update check — never blocks session start.
      Promise.resolve(checkForUpdate(sessionPort)).catch(() => {});

      let configSummary = "No config loaded.";
      try {
        configSummary = await loadPersistentConfig(input.cwd);
        await sessionPort.log(configSummary);
      } catch (error) {
        configSummary = `Config load failed: ${error?.message ?? error}`;
        await sessionPort.log(configSummary, { level: "warning" });
      }

      return {
        additionalContext: getSessionStartContext(configSummary)
      };
    },

    onUserPromptSubmitted: async () => getPromptContext(),

    onSessionEnd: async () => {
      await stopAllEmitters();
      return {
        sessionSummary: `${BRAND} tracked ${listStreams().length} event streams and ${listEmitters().configured.length} persistent emitter definitions.`,
        cleanupActions: [`Stopped session emitters managed by ${BRAND}.`]
      };
    }
  };

  return {
    hooks,
    getSessionStartContext,
    getPromptContext
  };
}
