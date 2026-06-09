import { BRAND, COPILOT_INSTRUCTIONS_PATH } from "../consts.mjs";
import { formatSessionInjectorContextSummary } from "../format/stream.mjs";
import { checkForUpdate as defaultCheckForUpdate } from "../update/checker.mjs";

function safeDiagnosticText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ") : null;
}

function isRawNodePathTypeError(message) {
  return /The "(?:path|paths\[\d+\]|from|to)" argument must be of type string/i.test(message)
    || (/argument must be of type string/i.test(message) && /\bpath\b/i.test(message));
}

function mayContainStackTrace(message) {
  return message.includes("\n")
    || /\bat\s+.+:\d+:\d+/.test(message);
}

function safeContextText(value) {
  const text = safeDiagnosticText(value);
  return text && !mayContainStackTrace(text) ? text : null;
}

function safeConfigLoadDetail(error) {
  const message = safeDiagnosticText(error?.message ?? (typeof error === "string" ? error : null));
  if (!message) {
    return "Unexpected error while loading persistent config.";
  }

  if (isRawNodePathTypeError(message)) {
    return "A required config path was missing or invalid. Ensure Copilot was started from a valid workspace and retry.";
  }

  if (mayContainStackTrace(message)) {
    return "Unexpected error while loading persistent config.";
  }

  return message;
}

function formatConfigLoadFailure(error) {
  const phase = safeContextText(error?.context?.phase ?? error?.phase);
  const filePath = safeContextText(error?.context?.filePath ?? error?.filePath);
  const phaseText = phase ? ` during ${phase}` : "";
  const pathText = filePath ? ` Path: ${filePath}.` : "";

  return `Config load failed${phaseText}: ${safeConfigLoadDetail(error)}${pathText}`;
}

function asList(items) {
  return Array.isArray(items) ? items : [];
}

function formatEmitterList(items) {
  return items.map((item) => item.name).join(", ");
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function formatFailedEmitters(items) {
  return items
    .map((item) => item.error ? `${item.name} (${item.error})` : item.name)
    .join(", ");
}

function normalizeCleanupOutcomes(result) {
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result?.emitterResults)) {
    return result.emitterResults;
  }
  if (Array.isArray(result?.outcomes)) {
    return result.outcomes;
  }
  return [];
}

function formatCleanupActions(cleanupResult) {
  const outcomes = normalizeCleanupOutcomes(cleanupResult);
  const stopped = asList(outcomes).filter((item) => (item?.outcome ?? (item?.timedOut ? "timedOut" : "stopped")) === "stopped");
  const timedOut = asList(outcomes).filter((item) => (item?.outcome ?? (item?.timedOut ? "timedOut" : "stopped")) === "timedOut");
  const failed = asList(outcomes).filter((item) => item?.outcome === "failed");
  const actions = [];

  if (stopped.length > 0) {
    actions.push(`Stopped ${stopped.length} session ${plural(stopped.length, "emitter")} managed by ${BRAND}: ${formatEmitterList(stopped)}.`);
  }
  if (timedOut.length > 0) {
    actions.push(`Timed out waiting for ${timedOut.length} session ${plural(timedOut.length, "emitter")} to stop: ${formatEmitterList(timedOut)}.`);
  }
  if (failed.length > 0) {
    actions.push(`Failed to stop ${failed.length} session ${plural(failed.length, "emitter")}: ${formatFailedEmitters(failed)}.`);
  }

  if (actions.length > 0) {
    return actions;
  }

  return [`No active session emitters needed cleanup for ${BRAND}.`];
}

export function createRuntimeHooks({
  streams,
  sessionPort,
  loadPersistentConfig,
  stopAllEmitters,
  stopAllEmittersAndWait = stopAllEmitters,
  shutdownSession,
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
        configSummary = formatConfigLoadFailure(error);
        await sessionPort.log(configSummary, { level: "warning" });
      }

      return {
        additionalContext: getSessionStartContext(configSummary)
      };
    },

    onUserPromptSubmitted: async () => getPromptContext(),

    onSessionEnd: async () => {
      const cleanupResult = typeof shutdownSession === "function"
        ? await shutdownSession()
        : await stopAllEmittersAndWait({ clearNotifications: true, clearReason: "session-shutdown" });
      return {
        sessionSummary: `${BRAND} tracked ${listStreams().length} event streams and ${listEmitters().configured.length} persistent emitter definitions.`,
        cleanupActions: formatCleanupActions(cleanupResult)
      };
    }
  };

  return {
    hooks,
    getSessionStartContext,
    getPromptContext
  };
}
