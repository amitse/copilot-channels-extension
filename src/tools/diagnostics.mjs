import { wrapToolHandler } from "./tool-handler.mjs";

function renderCanvasOpenResult(result) {
  return [
    "Opened tap diagnostics canvas.",
    result?.title ? `title=${result.title}` : null,
    result?.status ? `status=${result.status}` : null,
    result?.url ? `url=${result.url}` : null,
    result?.instanceId ? `instanceId=${result.instanceId}` : null,
    result?.availability ? `availability=${result.availability}` : null
  ].filter(Boolean).join("\n");
}

function summarizeRuntimeState(state) {
  const mode = state?.mode?.ok ? state.mode.value : `unavailable (${state?.mode?.error ?? "unknown"})`;
  const model = state?.model?.ok ? state.model.value : null;
  const taskCount = state?.tasks?.ok ? state.tasks.value?.tasks?.length ?? 0 : null;
  const scheduleCount = state?.schedules?.ok ? state.schedules.value?.entries?.length ?? 0 : null;
  const permissionCount = state?.permissions?.ok ? state.permissions.value?.items?.length ?? 0 : null;
  const canvasCount = state?.openCanvases?.ok ? state.openCanvases.value?.openCanvases?.length ?? 0 : null;
  return [
    `sessionId=${state?.sessionId ?? "(none)"}`,
    `mode=${typeof mode === "string" ? mode : JSON.stringify(mode)}`,
    model ? `model=${model.modelId ?? "unknown"} reasoning=${model.reasoningEffort ?? "default"} context=${model.contextTier ?? "default"}` : null,
    taskCount !== null ? `tasks=${taskCount}` : null,
    scheduleCount !== null ? `schedules=${scheduleCount}` : null,
    permissionCount !== null ? `pendingPermissions=${permissionCount}` : null,
    canvasCount !== null ? `openCanvases=${canvasCount}` : null,
    `elicitation=${state?.capabilities?.ui?.elicitation === true ? "available" : "unavailable"}`,
    `canvases=${state?.capabilities?.ui?.canvases === true ? "available" : "host-gated"}`
  ].filter(Boolean).join("\n");
}

export function createDiagnosticsTools(deps) {
  const diagnostics = deps.diagnostics ?? deps.runtime;
  if (!diagnostics || typeof diagnostics.openCanvas !== "function") {
    return [];
  }

  const tools = [
    {
      name: "tap_open_diagnostics_canvas",
      description: "Opens or focuses the Tap diagnostics canvas, a live flight recorder for streams, emitters, providers, logs, injection queues, and session events.",
      parameters: {
        type: "object",
        properties: {
          instanceId: {
            type: "string",
            description: "Stable canvas instance id. Reusing the same id focuses the existing diagnostics canvas."
          },
          limit: {
            type: "integer",
            minimum: 10,
            maximum: 300,
            description: "Maximum retained rows to show per diagnostics section."
          }
        }
      },
      handler: wrapToolHandler("tap_open_diagnostics_canvas", {}, async (args) => {
        const result = await diagnostics.openCanvas(args ?? {});
        return renderCanvasOpenResult(result);
      })
    }
  ];
  if (typeof diagnostics.getSessionRuntimeState === "function") {
    tools.push({
      name: "tap_get_session_state",
      description: "Reads current Copilot session runtime state for mode-aware tap workflows: mode, model, tasks, schedules, open canvases, and UI capabilities. This is read-only.",
      parameters: {
        type: "object",
        properties: {}
      },
      handler: wrapToolHandler("tap_get_session_state", {}, async () => {
        const state = await diagnostics.getSessionRuntimeState();
        return summarizeRuntimeState(state);
      })
    });
    if (typeof diagnostics.setSessionMode === "function") {
      tools.push({
        name: "tap_set_session_mode",
        description: "Guarded Copilot mode switch for tap workflows. Requires explicit confirmation text and is intended for interactive/plan/autopilot transitions only.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["interactive", "plan", "autopilot"],
              description: "Target Copilot session mode."
            },
            reason: {
              type: "string",
              description: "Why this mode switch is needed."
            },
            confirm: {
              type: "string",
              description: "Must be exactly 'set-session-mode' to confirm this user-visible mode change."
            }
          },
          required: ["mode", "reason", "confirm"]
        },
        handler: wrapToolHandler("tap_set_session_mode", (args) => ({ mode: args.mode }), async (args) => {
          if (args.confirm !== "set-session-mode") {
            throw new Error("Refusing to change session mode without confirm='set-session-mode'.");
          }
          const nextMode = await diagnostics.setSessionMode(args.mode);
          return `Session mode set to ${nextMode}. reason=${args.reason}`;
        })
      });
    }
  }
  if (typeof diagnostics.queryRecords === "function") {
    tools.push({
      name: "tap_query_records",
      description: "Reads structured tap records persisted in the session workspace, such as traces and stream-posts.",
      parameters: {
        type: "object",
        properties: {
          collection: {
            type: "string",
            description: "Record collection name, for example 'traces' or 'stream-posts'."
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum recent records to return."
          }
        },
        required: ["collection"]
      },
      handler: wrapToolHandler("tap_query_records", (args) => ({ collection: args.collection }), async (args) => {
        const result = diagnostics.queryRecords(args.collection, { limit: args.limit });
        return JSON.stringify(result, null, 2);
      })
    });
  }
  return tools;
}
